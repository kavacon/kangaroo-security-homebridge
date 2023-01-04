import {Alarm, Device, DOORBELL_ALARM, MOTION_ALARM} from "../model";
import {Client} from "../client/client";
import {Logging} from "homebridge";
import Timeout = NodeJS.Timeout;
import EventEmitter from "events";

const POLLING_DURATION_MILLISECONDS = 20000;

export declare interface NotificationService {
    on<T extends string>(event: `doorbell_ring_${T}`, listener: (alarm: Alarm) => void): this;
    on<T extends string>(event: `motion_detected_${T}`, listener: (alarm: Alarm) => void): this;
    on(event: 'new_device', listener: (device: Device, homeId: string) => void): this;
    on(event: 'removed_device', listener: (device: string) => void): this;

    emit<T extends string>(event: `doorbell_ring_${T}`, alarm: Alarm): boolean;
    emit<T extends string>(event: `motion_detected_${T}`, alarm: Alarm): boolean;
    emit(event: 'new_device', device: Device, homeId: string): boolean
    emit(event: 'removed_device', device: string): boolean
}

export class NotificationService extends EventEmitter {
    private readonly log: Logging;
    private readonly client: Client;
    private interval?: Timeout;
    private readonly lastAlarmByDevice: Map<string, string> = new Map();
    private knownDevices: string[] = [];

    constructor(log: Logging, client: Client) {
        super();
        this.log = log;
        this.client = client;
    }

    onShutdown() {
        clearInterval(this.interval);
    }

    start(devices: string[]) {
        this.knownDevices.push(...devices)
        this.interval = setInterval(this.runPoll.bind(this), POLLING_DURATION_MILLISECONDS);
    }

    private runPoll() {
        this.client.account()
            .then(({homes}) => {
                homes.forEach(h => h.devices.forEach(d => this.notifyDevice(d, h.homeId)));
                return homes.flatMap(({devices}) => devices)
            })
            .then(devices => {
                this.updateKnownDevices(devices);
            })
            .catch(reason => this.log(`notification service polling failed with reason ${reason}`))
    }

    private updateKnownDevices(devices: Device[]) {
        const deviceList = devices.map(d => d.deviceId);
        const staleDevices = this.knownDevices.filter(id => !deviceList.some(d => d === id));
        staleDevices.forEach(d => this.emit('removed_device', d));
        this.knownDevices = deviceList;
    }

    private notifyDevice(device: Device, homeId: string) {
        if (!this.knownDevices.some(id => id === device.deviceId)) {
            this.emit('new_device', device, homeId);
        } else {
            this.notifyAlarm(device.lastAlarm);
        }
    }

    private notifyAlarm(alarm: Alarm) {
        if (!this.lastAlarmByDevice.get(alarm.deviceId)) {
            this.lastAlarmByDevice.set(alarm.deviceId, alarm.alarmId);
        }
        if (this.lastAlarmByDevice.get(alarm.deviceId) === alarm.alarmId) {
            //ignore alarm already known
            return;
        }
        this.lastAlarmByDevice.set(alarm.deviceId, alarm.alarmId);
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