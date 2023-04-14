// adapted from https://github.com/Sunoo/homebridge-camera-ffmpeg/blob/master/src/ffmpeg.ts
import {Logger} from 'homebridge';
import ffmpeg from "fluent-ffmpeg";
import {Readable} from "stream";
import WritableStream = NodeJS.WritableStream;
import {Buffer} from "buffer";
import ffmpegPath from "ffmpeg-for-homebridge";
import ffProbePath from 'ffprobe-static';
import EventEmitter from "events";

process.env.FFMPEG_PATH = ffmpegPath;
process.env.FFPROBE_PATH = ffProbePath.path;

export interface FfmpegProcessOptions {
    input: string | Buffer | string[],
    output: string | WritableStream,
    inputOptions: string[],
    outputOptions: string[],
}

export enum FfmpegErrorCode {
    FATAL
}

export declare interface FfmpegProcess {
    on(event: 'ffmpeg_error', listener: (process: FfmpegProcess, error: FfmpegErrorCode) => void): this;
    on(event: 'ffmpeg_finished', listener: () => void): this;

    emit(event: 'ffmpeg_error', process: FfmpegProcess, error: FfmpegErrorCode): boolean;
    emit(event: 'ffmpeg_finished'): boolean;
    stop();
}

class FfmpegProcessImpl extends EventEmitter implements FfmpegProcess {
    private readonly command;
    private killTimeout?: NodeJS.Timeout;

    constructor(cameraName: string, options: FfmpegProcessOptions, log: Logger) {
        super()
        log.debug('command: %s %s %s %s', !(options.input instanceof Buffer) && options.input,
            options.inputOptions.join(' '), options.outputOptions?.join(' ') || '',
            typeof options.output == "string" && options.output,
            cameraName
        );

        let started = false;
        const startTime = Date.now();

        this.command = this.startCommand(options.input, log)
            .inputOptions(options.inputOptions)
            .output(options.output)
            .outputOptions(options.outputOptions)
            .on('progress', (progress) => {
                if (progress) {
                    if (!started && progress.frames > 0) {
                        started = true;
                        const runtime = (Date.now() - startTime) / 1000;
                        const message = 'Getting the first frames took ' + runtime + ' seconds.';
                        if (runtime < 5) {
                            log.debug(message, cameraName);
                        } else if (runtime < 22) {
                            log.warn(message, cameraName);
                        } else {
                            log.error(message, cameraName);
                        }
                    }
                }
            })
            .on('error', (error: Error) => {
                if (error.message.includes('SIGKILL')) {
                    this.handleKillSignal(log, cameraName);
                } else {
                    log.error('FFmpeg process creation failed: ' + error.message, cameraName);
                    this.emit('ffmpeg_error',this, FfmpegErrorCode.FATAL);
                }
            })
        .on('stderr', (line: string) => {
            if (line.match(/\[(panic|fatal|error)\]/)) { // For now only write anything out when debug is set
                log.error(line, cameraName);
                this.emit('ffmpeg_error',this, FfmpegErrorCode.FATAL);
            } else {
                log.debug(line, cameraName);
            }
        })
        .on('end', () => {
            this.emit('ffmpeg_finished');
        });
        this.command.run();
    }

    public stop(): void {
        this.killTimeout = setTimeout(() => {
            this.command.kill();
        }, 2 * 1000);
    }

    private startCommand(input: string | string[] | Buffer, logger: Logger) {
        const cmd = ffmpeg({logger});
        if (input instanceof Array<string>){
            input.forEach(i => cmd.input(i));
        } else if (input instanceof Buffer){
            cmd.input(Readable.from(input));
        } else {
            cmd.input(input);
        }
        return cmd;
    }

    private handleKillSignal(log: Logger, cameraName: string) {
        return () => {
            if (this.killTimeout) {
                clearTimeout(this.killTimeout);
            }

            const message = 'FFmpeg exited with';

            if (this.killTimeout) {
                log.debug(message + ' (Expected)', cameraName);
            } else {
                log.error(message + ' (Error)', cameraName);
                this.emit('ffmpeg_error',this, FfmpegErrorCode.FATAL);
            }
        }
    }
}

/**
 * Self completing ffmpeg process such as a video stitch or image resize. Managed as a promise
 * as may be long-running but is expected to naturally conclude.
 */
export function asyncFfmpeg(cameraName: string, options: FfmpegProcessOptions, log: Logger): Promise<FfmpegProcess> {
    return new Promise((resolve, reject) => {
        const process = new FfmpegProcessImpl(cameraName, options, log);
        process.on('ffmpeg_finished', () => resolve(process));
        process.on('ffmpeg_error', (error, process) => reject({error, process}));
    });
}

/**
 * An ongoing ffmpeg process. Expected to continue running until purposefully interrupted
 * either by a failure or explicit stop call.
 */
export function liveFfmpeg(cameraName: string, options: FfmpegProcessOptions, log: Logger): FfmpegProcess {
    return new FfmpegProcessImpl(cameraName, options, log);
}