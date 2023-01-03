// adapted from https://github.com/Sunoo/homebridge-camera-ffmpeg/blob/master/src/ffmpeg.ts
import {Logger, StreamRequestCallback} from 'homebridge';
import ffmpeg from "fluent-ffmpeg";

export type StreamAction = (sessionId: string) => void;

export interface FfmpegProcessOptions {
    input: string,
    output: string,
    inputOptions: string[],
    outputOptions: string[],
}

export class FfmpegProcess {
    private readonly command;
    private killTimeout?: NodeJS.Timeout;

    constructor(cameraName: string, sessionId: string, options: FfmpegProcessOptions, log: Logger,
                debug = false, onError: StreamAction, onForceStop: StreamAction, callback?: StreamRequestCallback) {
        log.debug('Stream command: %s %s %s %s', options.input, options.inputOptions.join(' '), options.outputOptions.join(' '), options.output, cameraName, debug);

        const commandOptions = {
            source: options.input,
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
                            log.debug(message, cameraName, debug);
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
                    this.handleKillSignal(log, cameraName, sessionId, onError, onForceStop, callback);
                } else {
                    log.error('FFmpeg process creation failed: ' + error.message, cameraName);
                    if (callback) {
                        callback(new Error('FFmpeg process creation failed'));
                    }
                    onError(sessionId);
                }
            })
        .on('stderr', (line: string) => {
            if (callback) {
                callback();
                callback = undefined;
            }
            if (line.match(/\[(panic|fatal|error)\]/)) { // For now only write anything out when debug is set
                log.error(line, cameraName);
            } else if (debug) {
                log.debug(line, cameraName, true);
            }
        })
        .on('end', () => {
            log.error('Process ended without kill signal, session: %s (Error) %s', sessionId, cameraName);
        });
        this.command.run();
    }

    public stop(): void {
        this.killTimeout = setTimeout(() => {
            this.command.kill();
        }, 2 * 1000);
    }

    private handleKillSignal(log: Logger, cameraName: string, sessionId: string, onError: StreamAction, onForceStop: StreamAction, callback?: StreamRequestCallback) {
        return () => {
            if (this.killTimeout) {
                clearTimeout(this.killTimeout);
            }

            const message = 'FFmpeg exited with';

            if (this.killTimeout) {
                log.debug(message + ' (Expected)', cameraName);
            } else {
                log.error(message + ' (Error)', cameraName);
                onError(sessionId);
                if (callback) {
                    callback(new Error(message));
                } else {
                    onForceStop(sessionId);
                }
            }
        }
    }
}