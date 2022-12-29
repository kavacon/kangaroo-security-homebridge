// adapted from https://github.com/Sunoo/homebridge-camera-ffmpeg/blob/master/src/configTypes.ts
export type VideoConfig = {
    deviceId: string,
    homeId: string;
    maxStreams?: number;
    maxWidth?: number;
    maxHeight?: number;
    maxFPS?: number;
    maxBitrate?: number;
    forceMax?: boolean;
    vcodec?: string;
    packetSize?: number;
    videoFilter?: string;
    encoderOptions?: string;
    mapvideo?: string;
    debug?: boolean;
    debugReturn?: boolean;
};