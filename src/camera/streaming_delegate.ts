// adapted from https://github.com/Sunoo/homebridge-camera-ffmpeg/blob/master/src/streamingDelegate.ts
// changed to dynamically retrieve and stitch feed from remote images
import {
    CameraController,
    CameraControllerOptions,
    CameraStreamingDelegate,
    HAP, Logger,
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
import { spawn } from 'child_process';
import { createSocket, Socket } from 'dgram';
import ffmpegPath from 'ffmpeg-for-homebridge';
import pickPort, { pickPortOptions } from 'pick-port';
import { VideoConfig } from './config';
import { FfmpegProcess } from './ffmpeg';
import {getDevice} from "../client";
import * as fs from "fs";
import fetch from 'node-fetch';

type SessionInfo = {
    address: string; // address of the HAP controller
    ipv6: boolean;

    videoPort: number;
    videoReturnPort: number;
    videoCryptoSuite: SRTPCryptoSuites; // should be saved if multiple suites are supported
    videoSRTP: Buffer; // key and salt concatenated
    videoSSRC: number; // rtp synchronisation source

    audioPort: number;
    audioReturnPort: number;
    audioCryptoSuite: SRTPCryptoSuites;
    audioSRTP: Buffer;
    audioSSRC: number;
};

type ResolutionInfo = {
    width: number;
    height: number;
    videoFilter?: string;
    snapFilter?: string;
    resizeFilter?: string;
};

type ActiveSession = {
    mainProcess?: FfmpegProcess;
    returnProcess?: FfmpegProcess;
    timeout?: NodeJS.Timeout;
    socket?: Socket;
};

export class StreamingDelegate implements CameraStreamingDelegate {
    private readonly hap: HAP;
    private readonly log: Logger;
    private readonly cameraName: string;
    private readonly config: VideoConfig;
    private readonly videoProcessor: string;
    private readonly tmpStorage: string;
    readonly controller: CameraController;
    private snapshotPromise?: Promise<Buffer>;

    // keep track of sessions
    pendingSessions: Map<string, SessionInfo> = new Map();
    ongoingSessions: Map<string, ActiveSession> = new Map();

    constructor(log: Logger, config: VideoConfig, hap: HAP, cameraName: string, tmpStorage: string) {
        this.log = log;
        this.hap = hap;
        this.config = config;
        this.tmpStorage = `${tmpStorage}/${config.homeId}/${config.deviceId}`;

        this.cameraName = cameraName;
        this.videoProcessor = ffmpegPath || 'ffmpeg';

        const options: CameraControllerOptions = {
            cameraStreamCount: this.config.maxStreams || 2, // HomeKit requires at least 2 streams, but 1 is also just fine
            delegate: this,
            streamingOptions: {
                supportedCryptoSuites: [hap.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
                video: {
                    resolutions: [
                        [320, 180, 30],
                        [320, 240, 15], // Apple Watch requires this configuration
                        [320, 240, 30],
                        [480, 270, 30],
                        [480, 360, 30],
                        [640, 360, 30],
                        [640, 480, 30],
                        [1280, 720, 30],
                        [1280, 960, 30],
                        [1920, 1080, 30],
                        [1600, 1200, 30]
                    ],
                    codec: {
                        profiles: [hap.H264Profile.BASELINE, hap.H264Profile.MAIN, hap.H264Profile.HIGH],
                        levels: [hap.H264Level.LEVEL3_1, hap.H264Level.LEVEL3_2, hap.H264Level.LEVEL4_0]
                    }
                },
            }
        };

        this.controller = new hap.CameraController(options);
    }

    private determineResolution(request: SnapshotRequest | VideoInfo, isSnapshot: boolean): ResolutionInfo {
        const resInfo: ResolutionInfo = {
            width: request.width,
            height: request.height
        };
        if (!isSnapshot) {
            if (this.config.maxWidth !== undefined &&
                (this.config.forceMax || request.width > this.config.maxWidth)) {
                resInfo.width = this.config.maxWidth;
            }
            if (this.config.maxHeight !== undefined &&
                (this.config.forceMax || request.height > this.config.maxHeight)) {
                resInfo.height = this.config.maxHeight;
            }
        }

        const filters: Array<string> = this.config.videoFilter?.split(',') || [];
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
    }

    fetchSnapshot(snapFilter?: string): Promise<Buffer> {
        this.snapshotPromise = getDevice(this.config.homeId, this.config.deviceId).
        then((device) => {
            return new Promise( (resolve, reject) => {
                const startTime = Date.now();
                const ffmpegArgs = `-i ${device.lastAlarm.images[0]}` + // Still
                    ' -frames:v 1' +
                    (snapFilter ? ' -filter:v ' + snapFilter : '') +
                    ' -f image2 -' +
                    ' -hide_banner' +
                    ' -loglevel error';

                this.log.debug('Snapshot command: ' + this.videoProcessor + ' ' + ffmpegArgs, this.cameraName, this.config.debug);
                const ffmpeg = spawn(this.videoProcessor, ffmpegArgs.split(/\s+/), {env: process.env});

                let snapshotBuffer = Buffer.alloc(0);
                ffmpeg.stdout.on('data', (data) => {
                    snapshotBuffer = Buffer.concat([snapshotBuffer, data]);
                });
                ffmpeg.on('error', (error: Error) => {
                    throw Error('FFmpeg process creation failed: ' + error.message);
                });
                ffmpeg.stderr.on('data', (data) => {
                    data.toString().split('\n').forEach((line: string) => {
                        if (this.config.debug && line.length > 0) { // For now only write anything out when debug is set
                            this.log.error(line, this.cameraName + '] [Snapshot');
                        }
                    });
                });
                ffmpeg.on('close', () => {
                    if (snapshotBuffer.length > 0) {
                        resolve(snapshotBuffer);
                    } else {
                        reject('Failed to fetch snapshot.');
                    }

                    setTimeout(() => {
                        this.snapshotPromise = undefined;
                    }, 3 * 1000); // Expire cached snapshot after 3 seconds

                    const runtime = (Date.now() - startTime) / 1000;
                    let message = 'Fetching snapshot took ' + runtime + ' seconds.';
                    if (runtime < 5) {
                        this.log.debug(message, this.cameraName, this.config.debug);
                    } else {
                        if (runtime < 22) {
                            this.log.warn(message, this.cameraName);
                        } else {
                            message += ' The request has timed out and the snapshot has not been refreshed in HomeKit.';
                            this.log.error(message, this.cameraName);
                        }
                    }
                });
            });
        });
        return this.snapshotPromise;
    }

    resizeSnapshot(snapshot: Buffer, resizeFilter?: string): Promise<Buffer> {
        return new Promise<Buffer>((resolve, reject) => {
            const ffmpegArgs = '-i pipe:' + // Resize
                ' -frames:v 1' +
                (resizeFilter ? ' -filter:v ' + resizeFilter : '') +
                ' -f image2 -';

            this.log.debug('Resize command: ' + this.videoProcessor + ' ' + ffmpegArgs, this.cameraName, this.config.debug);
            const ffmpeg = spawn(this.videoProcessor, ffmpegArgs.split(/\s+/), { env: process.env });

            let resizeBuffer = Buffer.alloc(0);
            ffmpeg.stdout.on('data', (data) => {
                resizeBuffer = Buffer.concat([resizeBuffer, data]);
            });
            ffmpeg.on('error', (error: Error) => {
                reject('FFmpeg process creation failed: ' + error.message);
            });
            ffmpeg.on('close', () => {
                resolve(resizeBuffer);
            });
            ffmpeg.stdin.end(snapshot);
        });
    }

    async handleSnapshotRequest(request: SnapshotRequest, callback: SnapshotRequestCallback): Promise<void> {
        const resolution = this.determineResolution(request, true);

        try {
            const cachedSnapshot = !!this.snapshotPromise;

            this.log.debug('Snapshot requested: ' + request.width + ' x ' + request.height,
                this.cameraName, this.config.debug);

            const snapshot = await (this.snapshotPromise || this.fetchSnapshot(resolution.snapFilter));

            this.log.debug('Sending snapshot: ' + (resolution.width > 0 ? resolution.width : 'native') + ' x ' +
                (resolution.height > 0 ? resolution.height : 'native') +
                (cachedSnapshot ? ' (cached)' : ''), this.cameraName, this.config.debug);

            const resized = await this.resizeSnapshot(snapshot, resolution.resizeFilter);
            callback(undefined, resized);
        } catch (err) {
            this.log.error(err as string, this.cameraName);
            callback();
        }
    }

    async prepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback): Promise<void> {
        const ipv6 = request.addressVersion === 'ipv6';

        const options: pickPortOptions = {
            type: 'udp',
            ip: ipv6 ? '::' : '0.0.0.0',
            reserveTimeout: 15
        };
        const videoReturnPort = await pickPort(options);
        const videoSSRC = this.hap.CameraController.generateSynchronisationSource();
        const audioReturnPort = await pickPort(options);
        const audioSSRC = this.hap.CameraController.generateSynchronisationSource();

        const sessionInfo: SessionInfo = {
            address: request.targetAddress,
            ipv6: ipv6,

            videoPort: request.video.port,
            videoReturnPort: videoReturnPort,
            videoCryptoSuite: request.video.srtpCryptoSuite,
            videoSRTP: Buffer.concat([request.video.srtp_key, request.video.srtp_salt]),
            videoSSRC: videoSSRC,

            audioPort: request.audio.port,
            audioReturnPort: audioReturnPort,
            audioCryptoSuite: request.audio.srtpCryptoSuite,
            audioSRTP: Buffer.concat([request.audio.srtp_key, request.audio.srtp_salt]),
            audioSSRC: audioSSRC
        };

        const response: PrepareStreamResponse = {
            video: {
                port: videoReturnPort,
                ssrc: videoSSRC,

                srtp_key: request.video.srtp_key,
                srtp_salt: request.video.srtp_salt
            },
            audio: {
                port: audioReturnPort,
                ssrc: audioSSRC,

                srtp_key: request.audio.srtp_key,
                srtp_salt: request.audio.srtp_salt
            }
        };

        this.pendingSessions.set(request.sessionID, sessionInfo);
        callback(undefined, response);
    }

    private async startStream(request: StartStreamRequest, callback: StreamRequestCallback): Promise<void>{
        const sessionInfo = this.pendingSessions.get(request.sessionID);
        if (sessionInfo) {
            const vcodec = this.config.vcodec || 'libx264';
            const mtu = this.config.packetSize || 1316; // request.video.mtu is not used
            let encoderOptions = this.config.encoderOptions;
            if (!encoderOptions && vcodec === 'libx264') {
                encoderOptions = '-preset ultrafast -tune zerolatency';
            }

            const resolution = this.determineResolution(request.video, false);

            let fps = (this.config.maxFPS !== undefined &&
                (this.config.forceMax || request.video.fps > this.config.maxFPS)) ?
                this.config.maxFPS : request.video.fps;
            let videoBitrate = (this.config.maxBitrate !== undefined &&
                (this.config.forceMax || request.video.max_bit_rate > this.config.maxBitrate)) ?
                this.config.maxBitrate : request.video.max_bit_rate;

            if (vcodec === 'copy') {
                resolution.width = 0;
                resolution.height = 0;
                resolution.videoFilter = undefined;
                fps = 0;
                videoBitrate = 0;
            }

            this.log.debug('Video stream requested: ' + request.video.width + ' x ' + request.video.height + ', ' +
                request.video.fps + ' fps, ' + request.video.max_bit_rate + ' kbps', this.cameraName, this.config.debug);
            this.log.info('Starting video stream: ' + (resolution.width > 0 ? resolution.width : 'native') + ' x ' +
                (resolution.height > 0 ? resolution.height : 'native') + ', ' + (fps > 0 ? fps : 'native') +
                ' fps, ' + (videoBitrate > 0 ? videoBitrate : '???') + ' kbps', this.cameraName);

            const framesListFile = await this.downloadPhotoStitch();
            let ffmpegArgs = `-framerate ${fps > 0 ? fps : 30} -f concat -i ${framesListFile}`;

            ffmpegArgs += // Video
                (this.config.mapvideo ? ' -map ' + this.config.mapvideo : ' -an -sn -dn') +
                ' -codec:v ' + vcodec +
                ' -pix_fmt yuv420p' +
                ' -color_range mpeg' +
                (fps > 0 ? ' -r ' + fps : '') +
                (encoderOptions ? ' ' + encoderOptions : '') +
                (resolution.videoFilter ? ' -filter:v ' + resolution.videoFilter : '') +
                (videoBitrate > 0 ? ' -b:v ' + videoBitrate + 'k' : '') +
                ' -payload_type ' + request.video.pt;

            ffmpegArgs += // Video Stream
                ' -ssrc ' + sessionInfo.videoSSRC +
                ' -f rtp' +
                ' -srtp_out_suite AES_CM_128_HMAC_SHA1_80' +
                ' -srtp_out_params ' + sessionInfo.videoSRTP.toString('base64') +
                ' srtp://' + sessionInfo.address + ':' + sessionInfo.videoPort +
                '?rtcpport=' + sessionInfo.videoPort + '&pkt_size=' + mtu;

            ffmpegArgs += ' -loglevel level' + (this.config.debug ? '+verbose' : '') +
                ' -progress pipe:1';

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
                    this.controller.forceStopStreamingSession(request.sessionID);
                    this.stopStream(request.sessionID);
                }, request.video.rtcp_interval * 5 * 1000);
            });
            activeSession.socket.bind(sessionInfo.videoReturnPort);

            activeSession.mainProcess = new FfmpegProcess(this.cameraName, request.sessionID, this.videoProcessor,
                ffmpegArgs, this.log, this.config.debug, this.stopStream.bind(this), this.controller.forceStopStreamingSession.bind(this.controller), callback);

            this.ongoingSessions.set(request.sessionID, activeSession);
            this.pendingSessions.delete(request.sessionID);
        } else {
            this.log.error('Error finding session information.', this.cameraName);
            callback(new Error('Error finding session information'));
        }
    }

    async handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): Promise<void> {
        switch (request.type) {
            case StreamRequestTypes.START:
                await this.startStream(request, callback);
                break;
            case StreamRequestTypes.RECONFIGURE:
                this.log.debug('Received request to reconfigure: ' + request.video.width + ' x ' + request.video.height + ', ' +
                    request.video.fps + ' fps, ' + request.video.max_bit_rate + ' kbps (Ignored)', this.cameraName, this.config.debug);
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


    private async downloadPhotoStitch(): Promise<string> {
        const device = await getDevice(this.config.homeId, this.config.deviceId);
        const images: string[] = []
        device.lastAlarm.images.forEach(
            async(image, index) => {
                const res = await fetch(image);
                const path = `${this.tmpStorage}/${device.lastAlarm.alarmId}_${index}.jpg`
                res.body.pipe(fs.createWriteStream(path))
                images.push(path);
            }
        );

        const outputFile = `${this.tmpStorage}/config.txt`
        fs.writeFileSync( outputFile, images.join('\n'))
        return outputFile;
    }
}