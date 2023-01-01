import {Alarm, DOORBELL_ALARM, MOTION_ALARM} from "../model";
import {Client} from "../client/client";
import {Logging} from "homebridge";
import Timeout = NodeJS.Timeout;
import EventEmitter from "events";

const POLLING_DURATION_MILLISECONDS = 30000;

export declare interface NotificationService {
    on<T extends string>(event: `doorbell_ring_${T}`, listener: (alarm: Alarm) => void): this;
    on<T extends string>(event: `motion_detected_${T}`, listener: (alarm: Alarm) => void): this;

    emit<T extends string>(event: `doorbell_ring_${T}`, alarm: Alarm): boolean;
    emit<T extends string>(event: `motion_detected_${T}`, alarm: Alarm): boolean;
}

export class NotificationService extends EventEmitter {
    private readonly log: Logging;
    private readonly client: Client;
    private readonly interval: Timeout;

    constructor(log: Logging, client: Client) {
        super();
        this.log = log;
        this.client = client;
        this.interval = setInterval(this.runPoll.bind(this), POLLING_DURATION_MILLISECONDS);
    }

    onShutdown() {
        clearInterval(this.interval);
    }

    onDoorbell(deviceId: string, listener: (alarm: Alarm) => void) {
        this.on(`doorbell_ring_${deviceId}`, listener);
    }

    onMotionDetected(deviceId: string, listener: (alarm: Alarm) => void) {
        this.on(`motion_detected_${deviceId}`, listener);
    }

    private runPoll() {
        this.client.account()
            .then(({homes}) =>
                homes
                    .flatMap(({devices}) => devices)
                    .forEach(({lastAlarm}) => this.notify(lastAlarm)))
            .catch(reason => this.log(`notification service polling failed with reason ${reason}`))
    }

    private notify(alarm: Alarm) {
        const currentTime = Date.now();
        const ttl = Date.parse(alarm.createTime) + POLLING_DURATION_MILLISECONDS;
        if (currentTime >= ttl) {
            return;
        }
        switch (alarm.alarmType) {
            case DOORBELL_ALARM:
                this.log.debug(`emitting notification for doorbell ring for device ${alarm.deviceId}`);
                this.emit(`doorbell_ring_${alarm.deviceId}`, alarm);
                return;
            case MOTION_ALARM:
                this.log.debug(`emitting notification for motion detected for device ${alarm.deviceId}`);
                this.emit(`motion_detected_${alarm.deviceId}`, alarm);
                return;
            default:
                this.log.warn(`unable to emit notification for alarm type: ${alarm.alarmType}`);
                return;
        }
    }
}