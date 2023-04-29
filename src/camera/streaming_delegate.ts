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
import pickPort, {pickPortOptions} from 'pick-port';
import {FfmpegErrorCode, asyncFfmpeg, liveFfmpeg} from './ffmpeg';
import EventEmitter from "events";
import {Alarm} from "../model";
import * as temp from "temp";
import * as fs from "fs";
import {createWriteStream} from "fs";
import {Buffer} from "buffer";
import {Writable} from "stream";
import {getResourcePath, NamedPromise, Resource, timedPromise} from "../util";
import GIFEncoder from 'gifencoder';
import {createCanvas, loadImage} from "canvas";
import WritableStream = NodeJS.WritableStream;
import {StreamingSession} from "./streaming_session";

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

export declare interface StreamingDelegate {
    on(event: 'stream_error', listener: (sessionID: string) => void): this;
    emit(event: 'stream_error', sessionID: string): boolean;
}

export class StreamingDelegate extends EventEmitter implements CameraStreamingDelegate{
    private readonly hap: HAP;
    private readonly log: Logger;
    private readonly cameraName: string;
    private readonly options?: VideoStitchOptions;
    private snapshot: Promise<Buffer>;
    private streamStitch: Promise<string>;

    // keep track of sessions
    requestedStreams: Map<string, SessionInfo> = new Map();
    activeStreams: Map<string, StreamingSession> = new Map();

    constructor(log: Logger, hap: HAP, cameraName: string, initialAlarm?: Alarm, options?: VideoStitchOptions) {
        super();
        this.log = log;
        this.hap = hap;
        this.options = options;

        this.cameraName = cameraName;
        this.snapshot = this.fetchSnapshot(getResourcePath(Resource.PLACEHOLDER));
        this.streamStitch = Promise.resolve(getResourcePath(Resource.PLACEHOLDER));
        if (initialAlarm) {
            this.updateAlarm(initialAlarm);
        }
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
        this.activeStreams.forEach(session => session.end())
        this.activeStreams.clear();
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

        const runtimeOptions = {
            log: this.log,
            debugMsg: this.cameraName,
            warnTime: {time: 5, msg: this.cameraName},
            errorTime: {
                time: 22,
                msg: `request has timed out, snapshot has not been refreshed in Home Kit ${this.cameraName}`
            }
        }

        const outputOptions = ['-frames:v 1', '-f image2', '-hide_banner', '-loglevel error']
        if (this.options?.rotation) {
            outputOptions.push(`-filter:v rotate=${this.options.rotation}*(PI/180)`)
        }

        const promiseSupplier = () => {
            this.log.debug('Creating snapshot process');
            const output = bufferStream();
            const options = {input: imageUrl, outputOptions, output: output.stream, inputOptions: []}
            const promise = asyncFfmpeg(this.cameraName, options, this.log)
                .catch(({error, process}) => {
                    switch (error) {
                        case FfmpegErrorCode.FATAL:
                            process.stop();
                            throw new Error('FFmpeg process creation failed for snapshot');
                    }
                })
                .then(() => {
                    if (output.buffer().length > 0) {
                        return output.buffer()
                    }
                    throw new Error('Failed to fetch snapshot.');
                })
            return {promise, name: 'fetchSnapshot'}
        };
        return timedPromise(promiseSupplier,  runtimeOptions)
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

        return timedPromise(() => this.buildGifStitch(imageUrls), runtimeOptions);
    }

    resize(input: Buffer, resizeFilter?: string): NamedPromise<Buffer> {
        const outputOptions = ['-frames:v 1', '-f image2', '-hide_banner', '-loglevel warning'];
        resizeFilter && outputOptions.push(`-filter:v ${resizeFilter}`)

        this.log.debug('Creating resize process');
        const output = bufferStream();
        const options = {input, outputOptions, output: output.stream, inputOptions: []};
        const promise = asyncFfmpeg(this.cameraName, options, this.log)
            .catch(({error, process}) => {
                switch (error) {
                    case FfmpegErrorCode.FATAL:
                        process.stop();
                        throw new Error('FFmpeg process creation failed for resize');

                }
            })
            .then(() => {
                    return output.buffer();
                }
            )
        return {promise, name: 'resize'};
    }

    handleSnapshotRequest(request: SnapshotRequest, callback: SnapshotRequestCallback): void {
        const resolution = this.determineResolution(request);
        this.log.debug('Snapshot requested: ' + request.width + ' x ' + request.height,
            this.cameraName);
        this.snapshot
            .then( snapshot => {
                this.log.debug('Sending snapshot: ' + (resolution.width > 0 ? resolution.width : 'native') + ' x ' +
                    (resolution.height > 0 ? resolution.height : 'native'), this.cameraName);
                return timedPromise(() => this.resize(snapshot, resolution.resizeFilter), {log: this.log});
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

                this.requestedStreams.set(request.sessionID, sessionInfo);
                callback(undefined, response);
            });
    }

    private startStream(request: StartStreamRequest, callback: StreamRequestCallback): void{
        const sessionInfo = this.requestedStreams.get(request.sessionID);
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

            const stream = new StreamingSession(request.sessionID, {
                ...sessionInfo,
                keepAliveSeconds: request.video.rtcp_interval * 5
            })
            stream.on('session_inactive', (session) => {
                this.log.info('Device appears to be inactive. Stopping stream.', this.cameraName);
                this.emit('stream_error', session.id);
                session.end();
            });
            stream.on('session_error', (message, session) => {
                this.log.error(message, this.cameraName);
                session?.end();
                this.log.info('Stopped video stream.', this.cameraName);
            });
            stream.on('process_error', (message, session) => {
                this.log.error(message, this.cameraName);
                session.end();
                this.emit('stream_error', session.id)
            });

            this.log.info('Starting video stream: ' + (resolution.width > 0 ? resolution.width : 'native') + ' x ' +
                (resolution.height > 0 ? resolution.height : 'native') + ', ' + (fps > 0 ? fps : 'native') +
                ' fps, ' + (videoBitrate > 0 ? videoBitrate : '???') + ' kbps', this.cameraName);
            this.streamStitch
                .then(input => {
                    this.log.debug('Creating stream process');
                    const process = liveFfmpeg(this.cameraName, {
                            input,
                            output,
                            inputOptions,
                            outputOptions
                        },
                        this.log);

                    stream.attachIncomingProcess(process);
                    this.requestedStreams.delete(request.sessionID);
                    this.activeStreams.set(stream.id, stream);
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
                this.activeStreams.get(request.sessionID)?.end();
                this.activeStreams.delete(request.sessionID);
                this.log.info('Stopped video stream.', this.cameraName);
                callback();
                break;
        }
    }

    private buildGifStitch(imageUrls: string[]): NamedPromise<string> {
        const imagePromises = imageUrls.map(imageUrl => loadImage(imageUrl))
        const promise =
            new Promise<string>(async (resolve, reject) => {
                const images = await Promise.all(imagePromises)
                const {width, height} = {width: images[0].width, height: images[0].height}
                const {path} = temp.openSync({suffix: '.gif'});
                this.log.debug(`saving gif as ${path}`);

                const writeStream = createWriteStream(path)
                writeStream.on('close', () => resolve(path))
                writeStream.on('error', err => reject(err))

                const encoder = new GIFEncoder(width, height);
                encoder.createReadStream().pipe(writeStream)
                encoder.start();
                encoder.setRepeat(0);   // 0 for repeat, -1 for no-repeat
                encoder.setDelay(250);  // frame delay in ms

                const canvas = createCanvas(width, height);
                const ctx = canvas.getContext('2d')
                images.forEach(image => {
                    ctx.drawImage(image, 0, 0, width, height);
                    encoder.addFrame(ctx);
                });

                encoder.finish();
            })
        return { promise, name: 'buildGifStitch'}
    }
}