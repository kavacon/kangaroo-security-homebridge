// adapted from https://github.com/Sunoo/homebridge-camera-ffmpeg/blob/master/src/ffmpeg.ts
import {Logger} from 'homebridge';
import ffmpeg from "fluent-ffmpeg";
import {Readable} from "stream";
import WritableStream = NodeJS.WritableStream;

export interface FfmpegProcessOptions {
    input: string | Buffer,
    output: string | WritableStream,
    inputOptions: string[],
    outputOptions: string[],
}

export type FfmpegCallback<T> = (arg?: Error | T) => void;

export class FfmpegProcess<T> {
    private readonly command;
    private killTimeout?: NodeJS.Timeout;

    constructor(cameraName: string, options: FfmpegProcessOptions, log: Logger, onError: CallableFunction, onFailure: CallableFunction, onEnd?: CallableFunction, callback?: FfmpegCallback<T>) {
        log.debug('command: %s %s %s %s', typeof options.input == "string" && options.input,
            options.inputOptions.join(' '), options.outputOptions?.join(' ') || '',
            typeof options.output == "string" && options.output,
            cameraName
        );

        const commandOptions = {
            source: typeof options.input == "string" ? options.input :  Readable.from(options.input),
            logger: log,
        }

        let started = false;
        const startTime = Date.now();

        this.command = ffmpeg(commandOptions)
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
                    this.handleKillSignal(log, cameraName, onError, onFailure, callback);
                } else {
                    log.error('FFmpeg process creation failed: ' + error.message, cameraName);
                    if (callback) {
                        callback(new Error('FFmpeg process creation failed'));
                    }
                    onError();
                }
            })
        .on('stderr', (line: string) => {
            if (callback) {
                callback();
                callback = undefined;
            }
            if (line.match(/\[(panic|fatal|error)\]/)) { // For now only write anything out when debug is set
                log.error(line, cameraName);
            } else {
                log.debug(line, cameraName);
            }
        })
        .on('end', () => {
            if (onEnd) {
                return onEnd();
            }
            log.error('Process ended without kill signal, (Error) %s', cameraName);
        });
        this.command.run();
    }

    public stop(): void {
        this.killTimeout = setTimeout(() => {
            this.command.kill();
        }, 2 * 1000);
    }

    private handleKillSignal(log: Logger, cameraName: string, onError: CallableFunction, onFailure: CallableFunction, callback?: FfmpegCallback<T>) {
        return () => {
            if (this.killTimeout) {
                clearTimeout(this.killTimeout);
            }

            const message = 'FFmpeg exited with';

            if (this.killTimeout) {
                log.debug(message + ' (Expected)', cameraName);
            } else {
                log.error(message + ' (Error)', cameraName);
                onError();
                if (callback) {
                    callback(new Error(message));
                } else {
                    onFailure();
                }
            }
        }
    }
}