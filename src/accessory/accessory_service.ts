import {Device, DeviceType, KangarooContext} from "../model";
import {VideoDoorbell} from "./video_doorbell";
import {Logging, PlatformAccessory, HAP, Categories, CharacteristicValue, PlatformConfig} from "homebridge";
import {Client} from "../client/client";
import {Accessory} from "./accessory";

interface AccessoryApi {
    Accessory: new(displayName: string, uuid: string, category?: Categories) => PlatformAccessory<KangarooContext>;
    register: (accessory: PlatformAccessory<KangarooContext>[]) => void;
    unregister: (accessory: PlatformAccessory<KangarooContext>[]) => void;
}

export class AccessoryService {
    private readonly log: Logging;
    private api: AccessoryApi;
    private readonly hap: HAP;
    private readonly client: Client
    private readonly config: PlatformConfig
    private readonly pendingAccessories: Accessory[] = [];
    private readonly registeredAccessories: Accessory[] = [];
    private deleteQueue: PlatformAccessory<KangarooContext>[] = [];

    constructor(log: Logging, api: AccessoryApi, hap: HAP, config: PlatformConfig, client: Client) {
        this.log = log;
        this.api = api;
        this.hap = hap;
        this.client = client;
        this.config = config;
    }

    addDevice(device: Device, homeId: string): Accessory | undefined {
        let knownAccessory = this.registeredAccessories.find(a => a.getDeviceId() === device.deviceId);
        knownAccessory = knownAccessory || this.pendingAccessories.find(a => a.getDeviceId() === device.deviceId)
        if (knownAccessory) {
            return knownAccessory;
        }
        this.log.info("Creating Accessory with Name : [%s], device type : [%s], Firmware: [%s] ",
            device.deviceName, device.deviceType, device.fwVersion);

        switch (device.deviceType) {
            case DeviceType.DOORCAM:
                const baseAccessory = this.buildBasicAccessory(device, homeId, Categories.VIDEO_DOORBELL)
                const accessory = new VideoDoorbell(baseAccessory, this.hap, this.log, this.client);
                accessory.initialise(device, this.config);
                this.pendingAccessories.push(accessory);
                return accessory;
            default:
                this.log.error(`unable to create accessory for ${device.deviceName} unknown device type ${device.deviceType}`);
        }
    }

    addCachedAccessory(baseAccessory: PlatformAccessory<KangarooContext>) {
        const res = this.client.getDevice(baseAccessory.context.homeId, baseAccessory.context.deviceId);
        res.then(device => {
            const service = baseAccessory.getService(this.hap.Service.AccessoryInformation);
            service?.getCharacteristic(this.hap.Characteristic.FirmwareRevision).updateValue('' + device.fwVersion)
            service?.getCharacteristic(this.hap.Characteristic.Name).updateValue(device.deviceName)

            switch (device.deviceType) {
                case DeviceType.DOORCAM:
                    const accessory = new VideoDoorbell(baseAccessory, this.hap, this.log, this.client);
                    accessory.initialise(device, this.config);
                    this.registeredAccessories.push(accessory);
                    return;
                default:
                    throw new Error(`unable to update accessory for ${device.deviceName} unknown device type ${device.deviceType}`);
            }
        }).catch(reason => {
            this.log.error('Accessory %s update failed with reason: %s, scheduling for removal', baseAccessory.displayName, reason);
            this.deleteQueue.push(baseAccessory)
        })
            .finally(() => this.log.info('Cached accessory %s processed', baseAccessory.displayName));
    }

    removeAccessory(deviceId: string) {
        const accessoryIndex = this.registeredAccessories.findIndex(a => a.getDeviceId() === deviceId);
        if (accessoryIndex !== -1) {
            const accessory = this.registeredAccessories.splice(accessoryIndex, 1)[0]
            accessory.onRemove();
            this.api.unregister([accessory.platformAccessory]);
        }
    }

    registerPendingAccessories() {
        const accessories = this.pendingAccessories.map(a => a.platformAccessory);
        this.api.register(accessories);
        this.registeredAccessories.push(...this.pendingAccessories);
        this.pendingAccessories.splice(0);
    }

    onShutdown() {
        this.registeredAccessories.forEach(accessory => accessory.onRemove());
    }

    onApiDidFinishLaunching() {
        this.log.info('[Accessory Service] apiDidFinishLaunching callback activating');
        this.api.unregister(this.deleteQueue);
        this.deleteQueue.splice(0);
        this.registerPendingAccessories();
        this.log.info('[Accessory Service] setup completed, %s accessories created or restored',
            this.registeredAccessories.length);
    }

    getRegisteredAccessories(): Accessory[] {
        return this.registeredAccessories;
    }

    private buildBasicAccessory(device: Device, homeId: string, category: Categories): PlatformAccessory<KangarooContext> {
        const context: KangarooContext = {
            homeId,
            deviceId: device.deviceId,
            deviceType: device.deviceType,
        }
        const uuid = device.deviceId.replace('D_', '');
        const accessory: PlatformAccessory<KangarooContext> = new this.api.Accessory(device.deviceName, uuid, category);
        const accessoryInformation = accessory.getService(this.hap.Service.AccessoryInformation)!;
        accessoryInformation
            .setCharacteristic(this.hap.Characteristic.Name, device.deviceName)
            .setCharacteristic(this.hap.Characteristic.SerialNumber, device.serialNumber)
            .setCharacteristic(this.hap.Characteristic.Manufacturer, 'kangaroo')
            .setCharacteristic(this.hap.Characteristic.Model, device.deviceModel)
            .setCharacteristic(this.hap.Characteristic.FirmwareRevision, '' + device.fwVersion);

        accessoryInformation.getCharacteristic(this.hap.Characteristic.Name)
            .onSet((value: CharacteristicValue, _) => {
                return this.client.updateDevice(homeId, device.deviceId, {deviceName: '' + value})
                    .then(device => device.deviceName)
            });
        accessory.context = context;
        return accessory;
    }
}