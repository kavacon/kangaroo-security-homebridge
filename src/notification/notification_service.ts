import {Device} from "../model";
import {Client} from "../client/client";
import {Logging} from "homebridge";
import Timeout = NodeJS.Timeout;
import EventEmitter from "events";
import {DeviceDeleter, DeviceReceiver} from "./receiver";
import {Accessory} from "../accessory/accessory";

const POLLING_DURATION_MILLISECONDS = 20000;

export declare interface NotificationService {
    on<T extends string>(event: `device_update_${T}`, DeviceReceiver): this;
    on(event: 'new_device', listener: DeviceReceiver): this;
    on(event: 'removed_device', listener: DeviceDeleter): this;

    emit<T extends string>(event: `device_update_${T}`, device: Device, homeId: string): boolean;
    emit(event: 'new_device', device: Device, homeId: string): boolean
    emit(event: 'removed_device', device: string): boolean
}

export class NotificationService extends EventEmitter {
    private readonly log: Logging;
    private readonly client: Client;
    private interval?: Timeout;
    private knownDevices: string[] = [];

    constructor(log: Logging, client: Client) {
        super();
        this.log = log;
        this.client = client;
    }

    onShutdown() {
        clearInterval(this.interval);
        this.removeAllListeners();
    }

    start(accessories: Accessory[]) {
        accessories.forEach(a => {
            this.knownDevices.push(a.getDeviceId())
            this.on(`device_update_${a.getDeviceId()}`, (d, h) => a.onUpdate(d, h))
        })
        this.interval = setInterval(this.runPoll.bind(this), POLLING_DURATION_MILLISECONDS);
    }

    private runPoll() {
        let lastStep = 'start';
        this.client.account()
            .then(({homes}) => {
                homes.forEach(h => h.devices.forEach(d => this.notifyDevice(d, h.homeId)));
                lastStep = 'find_devices'
                return homes.flatMap(({devices}) => devices)
            })
            .then(devices => {
                this.updateKnownDevices(devices);
                lastStep = 'update_known_devices'
            })
            .catch(reason => this.log(`notification service polling failed at ${lastStep} with reason ${reason}`))
    }

    private updateKnownDevices(devices: Device[]) {
        const deviceList = devices.map(d => d.deviceId);
        const staleDevices = this.knownDevices.filter(id => !deviceList.some(d => d === id));
        staleDevices.forEach(d => this.removeAllListeners(`device_update_${d}`));
        staleDevices.forEach(d => this.emit('removed_device', d));
        this.knownDevices = deviceList;
    }

    private notifyDevice(device: Device, homeId: string) {
        if (!this.knownDevices.some(id => id === device.deviceId)) {
            this.emit('new_device', device, homeId);
        } else {
            this.emit(`device_update_${device.deviceId}`, device, homeId)
        }
    }
}