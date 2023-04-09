// adapted from https://github.com/Sunoo/homebridge-camera-ffmpeg/blob/master/src/streamingDelegate.ts
// changed to dynamically retrieve and stitch feed from remote images
import {
    CameraStreamingDelegate,
    HAP,
    HAPStatus,
    Logger,
    PrepareStreamCallback,
    PrepareStreamRequest,
    PrepareStreamResponse,
    SnapshotRequest,
    SnapshotRequestCallback,
    SRTPCryptoSuites,
    StartStreamRequest,
    StreamingRequest,
    StreamRequestCallback,
    StreamRequestTypes,
    VideoInfo
} from 'homebridge';
import {createSocket, Socket} from 'dgram';
import pickPort, {pickPortOptions} from 'pick-port';
import {FfmpegProcess} from './ffmpeg';
import EventEmitter from "events";
import {Alarm} from "../model";
import * as temp from "temp";
import * as fs from "fs";
import {Buffer} from "buffer";
import {Writable} from "stream";
import {getResourcePath, NamedProcess, Resource, thenWithRuntime} from "../util";
import WritableStream = NodeJS.WritableStream;
import GIFEncoder from 'gif-encoder';
import {createCanvas, loadImage} from "canvas";

temp.track();

type SessionInfo = {
    address: string; // address of the HAP controller
    ipv6: boolean;

    videoPort: number;
    videoReturnPort: number;
    videoCryptoSuite: SRTPCryptoSuites; // should be saved if multiple suites are supported
    videoSRTP: Buffer; // key and salt concatenated
    videoSSRC: number; // rtp synchronisation source
};

type ResolutionInfo = {
    width: number;
    height: number;
    videoFilter?: string;
    snapFilter?: string;
    resizeFilter?: string;
};

type ActiveSession = {
    mainProcess?: FfmpegProcess<void>;
    returnProcess?: FfmpegProcess<void>;
    timeout?: NodeJS.Timeout;
    socket?: Socket;
};

type VideoStitchOptions = {
    fps?: number,
    runtime?: number,
    rotation?: number
}

interface BufferStream {
    buffer: () => Buffer;
    stream: WritableStream;
}

function bufferStream(): BufferStream {
    let buffer = Buffer.alloc(0);
    return {
        buffer: () => buffer,
        stream: new Writable({
            write(chunk: any, encoding: BufferEncoding, callback: (error?: (Error | null)) => void) {
                buffer = Buffer.concat([buffer, chunk]);
            }
        })
    };
}

export declare interface StreamingDelegate extends CameraStreamingDelegate {
    on(event: 'stream_error', listener: (sessionID: string) => void): this;
    emit(event: 'stream_error', sessionID: string): boolean;
}

export class StreamingDelegate extends EventEmitter {
    private readonly hap: HAP;
    private readonly log: Logger;
    private readonly cameraName: string;
    private readonly options?: VideoStitchOptions;
    private snapshot: Promise<Buffer>;
    private streamStitch: Promise<string>;

    // keep track of sessions
    pendingSessions: Map<string, SessionInfo> = new Map();
    ongoingSessions: Map<string, ActiveSession> = new Map();

    constructor(log: Logger, hap: HAP, cameraName: string, initialAlarm: Alarm, options?: VideoStitchOptions,) {
        super();
        this.log = log;
        this.hap = hap;
        this.options = options;

        this.cameraName = cameraName;
        this.snapshot = this.fetchSnapshot(getResourcePath(Resource.PLACEHOLDER));
        this.streamStitch = Promise.resolve(getResourcePath(Resource.PLACEHOLDER));
    }

    private determineResolution(request: SnapshotRequest | VideoInfo): ResolutionInfo {
        const resInfo: ResolutionInfo = {
            width: request.width,
            height: request.height
        };

        const filters: Array<string> = [];
        const noneFilter = filters.indexOf('none');
        if (noneFilter >= 0) {
            filters.splice(noneFilter, 1);
        }
        resInfo.snapFilter = filters.join(',');
        if ((noneFilter < 0) && (resInfo.width > 0 || resInfo.height > 0)) {
            resInfo.resizeFilter = 'scale=' + (resInfo.width > 0 ? '\'min(' + resInfo.width + ',iw)\'' : 'iw') + ':' +
                (resInfo.height > 0 ? '\'min(' + resInfo.height + ',ih)\'' : 'ih') +
                ':force_original_aspect_ratio=decrease';
            filters.push(resInfo.resizeFilter);
            filters.push('scale=trunc(iw/2)*2:trunc(ih/2)*2'); // Force to fit encoder restrictions
        }

        if (filters.length > 0) {
            resInfo.videoFilter = filters.join(',');
        }

        return resInfo;
    }

    shutdown() {
        for (const session in this.ongoingSessions) {
            this.stopStream(session);
        }
        this.streamStitch.then(
            path => fs.rmSync(path, {force: true})
        );
    }

    updateAlarm(alarm: Alarm) {
        if (!alarm.images) {
            return;
        }
        this.snapshot = this.fetchSnapshot(alarm.images[0]);
        this.streamStitch.then(
            path => fs.rmSync(path, {force: true})
        );
        this.streamStitch = this.fetchStreamStitch(alarm.images);
    }

    fetchSnapshot(imageUrl: string): Promise<Buffer> {
        if (!imageUrl) {
            return Promise.reject('no image available for snapshot')
        }
        return new Promise( (resolve, reject) => {
            const startTime = Date.now();
            const outputOptions = ['-frames:v 1', '-f image2', '-hide_banner', '-loglevel error']
            if (this.options?.rotation) {
                outputOptions.push(`-filter:v rotate=${this.options.rotation}*(PI/180)`)
            }
            this.log.debug('Creating snapshot process');
            const output = bufferStream();
            const options = {input: imageUrl, outputOptions, output: output.stream, inputOptions: []}
            const onError = () => {reject('FFmpeg process creation failed for snapshot'); ffmpeg.stop();}
            const onEnd = () => {
                if (output.buffer().length > 0) {
                    resolve(output.buffer());
                } else {
                    reject('Failed to fetch snapshot.');
                }

                const runtime = (Date.now() - startTime) / 1000;
                let message = 'Fetching snapshot took ' + runtime + ' seconds.';
                if (runtime < 5) {
                    this.log.debug(message, this.cameraName);
                } else {
                    if (runtime < 22) {
                        this.log.warn(message, this.cameraName);
                    } else {
                        message += ' The request has timed out and the snapshot has not been refreshed in HomeKit.';
                        this.log.error(message, this.cameraName);
                    }
                }
            };
            const ffmpeg = new FfmpegProcess(this.cameraName, options, this.log, onError, onError, onEnd);
        });
    }

    fetchStreamStitch(imageUrls: string[]): Promise<string> {
        const runtimeOptions = {
            log: this.log,
            debugMsg: this.cameraName,
            warnTime: {time: 5, msg: this.cameraName},
            errorTime: {
                time: 22,
                msg: `request has timed out, stitch has not been refreshed in Home Kit ${this.cameraName}`
            }
        }

        return thenWithRuntime(() => this.buildGifStitch(imageUrls), runtimeOptions);
    }

    resize(input: Buffer, resizeFilter?: string): Promise<Buffer> {
        return new Promise<Buffer>((resolve, reject) => {
            const outputOptions = ['-frames:v 1', '-f image2', '-hide_banner', '-loglevel warning'];
            resizeFilter && outputOptions.push(`-filter:v ${resizeFilter}`)

            this.log.debug('Creating resize process');
            const output = bufferStream();
            const options = {input, outputOptions, output: output.stream, inputOptions: []}
            const onError = () => {reject('FFmpeg process creation failed for resize'); ffmpeg.stop();}
            const onEnd = () => resolve(output.buffer());
            const ffmpeg = new FfmpegProcess(this.cameraName, options, this.log, onError, onError, onEnd);
        });
    }

    handleSnapshotRequest(request: SnapshotRequest, callback: SnapshotRequestCallback): void {
        const resolution = this.determineResolution(request);
        this.log.debug('Snapshot requested: ' + request.width + ' x ' + request.height,
            this.cameraName);
        this.snapshot
            .then( snapshot => {
                this.log.debug('Sending snapshot: ' + (resolution.width > 0 ? resolution.width : 'native') + ' x ' +
                    (resolution.height > 0 ? resolution.height : 'native'), this.cameraName);
                return this.resize(snapshot, resolution.resizeFilter);
            })
            .then(resized => callback(undefined, resized))
            .catch(err => {
            this.log.error(err as string, this.cameraName);
            callback(HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
        })
    }

    prepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback): void {
        const ipv6 = request.addressVersion === 'ipv6';

        const options: pickPortOptions = {
            type: 'udp',
            ip: ipv6 ? '::' : '0.0.0.0',
            reserveTimeout: 15
        };
        pickPort(options)
            .then(videoReturnPort => {
                const videoSSRC = this.hap.CameraController.generateSynchronisationSource();

                const sessionInfo: SessionInfo = {
                    address: request.targetAddress,
                    ipv6: ipv6,

                    videoPort: request.video.port,
                    videoReturnPort: videoReturnPort,
                    videoCryptoSuite: request.video.srtpCryptoSuite,
                    videoSRTP: Buffer.concat([request.video.srtp_key, request.video.srtp_salt]),
                    videoSSRC: videoSSRC,
                };

                const response: PrepareStreamResponse = {
                    video: {
                        port: videoReturnPort,
                        ssrc: videoSSRC,

                        srtp_key: request.video.srtp_key,
                        srtp_salt: request.video.srtp_salt
                    },
                };

                this.pendingSessions.set(request.sessionID, sessionInfo);
                callback(undefined, response);
            });
    }

    private startStream(request: StartStreamRequest, callback: StreamRequestCallback): void{
        const sessionInfo = this.pendingSessions.get(request.sessionID);
        if (sessionInfo) {
            const vcodec = 'libx264';
            const mtu = 1316; // request.video.mtu is not used
            const rotation = this.options?.rotation ? `,rotate=${this.options.rotation}*(PI/180)` : '';

            const resolution = this.determineResolution(request.video);

            const fps = request.video.fps;
            const videoBitrate = request.video.max_bit_rate;

            this.log.debug('Video stream requested: ' + request.video.width + ' x ' + request.video.height + ', ' +
                request.video.fps + ' fps, ' + request.video.max_bit_rate + ' kbps', this.cameraName);
            const output = `srtp://${sessionInfo.address}:${sessionInfo.videoPort}?rtcpport=${sessionInfo.videoPort}'&pkt_size=${mtu}`
            const inputOptions = [
                '-stream_loop -1',
                '-an',
                '-sn',
                '-dn',
            ]
            const outputOptions = [
                `-codec:v ${vcodec}`,
                '-pix_fmt yuv420p',
                '-color_range mpeg',
                `-r ${this.options?.fps || request.video.fps}`,
                '-preset ultrafast',
                '-tune zerolatency',
                `-filter:v ${resolution.videoFilter + rotation}`,
                `-b:v ${videoBitrate}k`,
                `-payload_type ${request.video.pt}`,

                // Video Stream
                `-ssrc ${sessionInfo.videoSSRC}`,
                '-f rtp',
                '-srtp_out_suite AES_CM_128_HMAC_SHA1_80',
                `-srtp_out_params ${sessionInfo.videoSRTP.toString('base64')}`,
                '-hide_banner',
                `-loglevel warning`,
                '-progress pipe:1'
            ]

            const activeSession: ActiveSession = {};

            activeSession.socket = createSocket(sessionInfo.ipv6 ? 'udp6' : 'udp4');
            activeSession.socket.on('error', (err: Error) => {
                this.log.error('Socket error: ' + err.message, this.cameraName);
                this.stopStream(request.sessionID);
            });
            activeSession.socket.on('message', () => {
                if (activeSession.timeout) {
                    clearTimeout(activeSession.timeout);
                }
                activeSession.timeout = setTimeout(() => {
                    this.log.info('Device appears to be inactive. Stopping stream.', this.cameraName);
                    this.emit('stream_error', request.sessionID);
                    this.stopStream(request.sessionID);
                }, request.video.rtcp_interval * 5 * 1000);
            });
            activeSession.socket.bind(sessionInfo.videoReturnPort);
            this.log.info('Starting video stream: ' + (resolution.width > 0 ? resolution.width : 'native') + ' x ' +
                (resolution.height > 0 ? resolution.height : 'native') + ', ' + (fps > 0 ? fps : 'native') +
                ' fps, ' + (videoBitrate > 0 ? videoBitrate : '???') + ' kbps', this.cameraName);
            this.streamStitch
                .then(input => {
                    this.log.debug('Creating stream process');
                    activeSession.mainProcess = new FfmpegProcess(this.cameraName, {
                            input,
                            output,
                            inputOptions,
                            outputOptions
                        },
                        this.log, () => this.stopStream(request.sessionID), () => this.emit('stream_error', request.sessionID), undefined);

                    this.ongoingSessions.set(request.sessionID, activeSession);
                    this.pendingSessions.delete(request.sessionID);
                    callback();
                })
                .catch(err => {
                    this.log.error('Error starting stream for %s', this.cameraName, err);
                    callback(new Error('Error starting stream for ' + this.cameraName));
                });
        } else {
            this.log.error('Error finding session information.', this.cameraName);
            callback(new Error('Error finding session information'));
        }
    }

    handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): void {
        switch (request.type) {
            case StreamRequestTypes.START:
                this.startStream(request, callback);
                break;
            case StreamRequestTypes.RECONFIGURE:
                this.log.debug('Received request to reconfigure: ' + request.video.width + ' x ' + request.video.height + ', ' +
                    request.video.fps + ' fps, ' + request.video.max_bit_rate + ' kbps (Ignored)', this.cameraName);
                callback();
                break;
            case StreamRequestTypes.STOP:
                this.stopStream(request.sessionID);
                callback();
                break;
        }
    }

    public stopStream(sessionId: string): void {
        const session = this.ongoingSessions.get(sessionId);
        if (session) {
            if (session.timeout) {
                clearTimeout(session.timeout);
            }
            try {
                session.socket?.close();
            } catch (err) {
                this.log.error('Error occurred closing socket: ' + err, this.cameraName);
            }
            try {
                session.mainProcess?.stop();
            } catch (err) {
                this.log.error('Error occurred terminating main FFmpeg process: ' + err, this.cameraName);
            }
            try {
                session.returnProcess?.stop();
            } catch (err) {
                this.log.error('Error occurred terminating two-way FFmpeg process: ' + err, this.cameraName);
            }
        }
        this.ongoingSessions.delete(sessionId);
        this.log.info('Stopped video stream.', this.cameraName);
    }

    private buildGifStitch(imageUrls: string[]): NamedProcess<string> {
        const imagePromises = imageUrls.map(imageUrl => loadImage(imageUrl))
        const gif = Promise.all(imagePromises)
            .then(images => {
                const {width, height} = {width: images[0].width, height: images[0].height}
                const encoder = new GIFEncoder(width, height);
                const {path} = temp.openSync({suffix: '.gif'});
                this.log.debug(`saving gif as ${path}`);

                encoder.createReadStream().pipe(fs.createWriteStream(path));
                encoder.start();
                encoder.setRepeat(0);   // 0 for repeat, -1 for no-repeat
                encoder.setDelay(500);  // frame delay in ms

                const canvas = createCanvas(width, height);
                const ctx = canvas.getContext('2d')
                images.forEach(image => {
                    ctx.drawImage(image, 0, 0, width, height);
                    encoder.addFrame(ctx);
                });

                encoder.finish();
                return path
            })
        return {process: gif, name: 'buildGifStitch'}
    }
}