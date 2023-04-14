import {createSocket, Socket} from "dgram";
import EventEmitter from "events";
import Timeout = NodeJS.Timeout;
import {FfmpegErrorCode, FfmpegProcess} from "./ffmpeg";

type StreamInfo = {
    ipv6: boolean;
    videoReturnPort: number;
    keepAliveSeconds: number;
};

type Process = FfmpegProcess
export declare interface StreamingSession {
    on(event: 'session_error', listener: (message: string, session?: StreamingSession) => void): this;
    on(event: 'session_inactive', listener: (session: StreamingSession) => void): this;
    on(event: 'process_error', listener: (session: StreamingSession) => void): this;

    emit(event: 'session_error', message: string, session?: StreamingSession): boolean;
    emit(event: 'session_inactive', session: StreamingSession): boolean;
    emit(event: 'process_error', session: StreamingSession): boolean;

}

export class StreamingSession extends EventEmitter {
    public id: string;
    private readonly info: StreamInfo;
    private socket?: Socket
    private timeout?: Timeout
    private incomingProcess?: Process
    constructor(id: string, info: StreamInfo) {
        super()
        this.id = id
        this.info = info;
    }

    start() {
        this.socket = createSocket(this.info.ipv6 ? 'udp6' : 'udp4');
        this.socket.on('error', (err: Error) => {
            this.emit('session_error', `socket error: ${err.message}`, this)
        });
        this.socket.on('message', () => {
            if (this.timeout) {
                clearTimeout(this.timeout);
            }
            this.timeout = setTimeout(() => {
                this.emit('session_inactive', this)
            }, this.info.keepAliveSeconds * 1000);
        });
        this.socket.bind(this.info.videoReturnPort);
    }

    attachIncomingProcess(process: Process) {
        this.incomingProcess = process;
        this.incomingProcess.on('ffmpeg_error', (_, error) => {
            switch (error) {
                case FfmpegErrorCode.FATAL:
                    this.emit('process_error', this);
            }
        })
    }

    end() {
        if (this.timeout) {
            clearTimeout(this.timeout);
        }
        try {
            this.socket?.close();
        } catch (err) {
            this.emit('session_error', `error occurred closing socket: ${err}`);
        }
        try {
            this.incomingProcess?.stop();
        } catch (err) {
            this.emit('session_error', `error occurred terminating main FFmpeg process: ${err}`);
        }
    }
}