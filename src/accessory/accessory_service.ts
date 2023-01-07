import {Device, DeviceType, KangarooContext} from "../model";
import {VideoDoorbellService} from "./video_doorbell";
import {Logging, PlatformAccessory, HAP, Categories, CharacteristicValue, PlatformConfig} from "homebridge";
import {Client} from "../client/client";
import {NotificationService} from "../notification/notification_service";

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
    private readonly videoDoorbellService: VideoDoorbellService;
    private readonly accessories: PlatformAccessory<KangarooContext>[] = [];
    private readonly cachedAccessories: PlatformAccessory<KangarooContext>[] = [];
    private deleteQueue: PlatformAccessory<KangarooContext>[] = [];
    private shutdownActions: (() => void)[] = []

    constructor(log: Logging, api: AccessoryApi, hap: HAP, config: PlatformConfig, client: Client, notificationService: NotificationService) {
        this.log = log;
        this.api = api;
        this.hap = hap;
        this.client = client;
        this.videoDoorbellService = new VideoDoorbellService(log, hap, client, config, notificationService)
        notificationService.on('new_device', this.addDevice.bind(this))
        notificationService.on('removed_device', this.deleteDevice.bind(this))
    }

    fromDevice(device: Device, homeId: string): PlatformAccessory<KangarooContext> | undefined {
        const cachedAccessory = this.cachedAccessories.find(a => a.context.deviceId === device.deviceId)
        if (cachedAccessory) {
            return cachedAccessory;
        }
        this.log.info("Creating Accessory with Name : [%s], device type : [%s], Firmware: [%s] ",
            device.deviceName, device.deviceType, device.fwVersion);

        switch (device.deviceType) {
            case DeviceType.DOORCAM:
                const baseAccessory = this.buildBasicAccessory(device, homeId, Categories.VIDEO_DOORBELL)
                const {accessory, cleanup } = this.videoDoorbellService.configure(device, baseAccessory)
                this.shutdownActions.push(cleanup);
                this.accessories.push(accessory);
                return accessory;
            default:
                this.log.error(`unable to create accessory for ${device.deviceName} unknown device type ${device.deviceType}`);
        }
    }

    updateAccessory(baseAccessory: PlatformAccessory<KangarooContext>) {
        const res = this.client.getDevice(baseAccessory.context.homeId, baseAccessory.context.deviceId);
        res.then( device => {
            const service = baseAccessory.getService(this.hap.Service.AccessoryInformation);
            service?.getCharacteristic(this.hap.Characteristic.FirmwareRevision).updateValue(''+device.fwVersion)
            service?.getCharacteristic(this.hap.Characteristic.Name).updateValue(device.deviceName)

            switch (device.deviceType) {
                case DeviceType.DOORCAM:
                    const {accessory, cleanup } = this.videoDoorbellService.configure(device, baseAccessory)
                    this.shutdownActions.push(cleanup);
                    this.cachedAccessories.push(accessory);
                    return;
                default:
                    throw new Error(`unable to update accessory for ${device.deviceName} unknown device type ${device.deviceType}`);
            }
        }).catch( reason => {
            this.log.error('Accessory %s update failed with reason: %s, scheduling for removal', baseAccessory.displayName, reason);
            this.deleteQueue.push(baseAccessory)
        })
            .finally(() => this.log.info('Cached accessory %s processed', baseAccessory.displayName));
    }

    onShutdown() {
        this.shutdownActions.forEach( action => action());
    }

    onApiDidFinishLaunching() {
        this.log.info('[Accessory Service] apiDidFinishLaunching callback activating');
        this.api.unregister(this.deleteQueue);
        this.api.register(this.accessories);
        this.log.info('[Accessory Service] setup completed, %s accessories created, %s cached accessories maintained',
            this.accessories.length, this.cachedAccessories.length);
    }

    getDeviceIds(): string[] {
        return this.cachedAccessories.concat(this.accessories).map(a => a.context.deviceId);
    }

    private deleteDevice(deviceId: string) {
        const cachedAccessory = this.cachedAccessories.find(a => a.context.deviceId === deviceId);
        const accessory = cachedAccessory || this.accessories.find(a => a.context.deviceId === deviceId);
        if (accessory) {
            this.api.unregister([accessory]);
        }
    }

    private addDevice(device: Device, homeId: string) {
        const accessory = this.fromDevice(device, homeId);
        accessory && this.api.register([accessory])
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
            .setCharacteristic(this.hap.Characteristic.FirmwareRevision, ''+device.fwVersion);

        accessoryInformation.getCharacteristic(this.hap.Characteristic.Name)
            .onSet((value: CharacteristicValue, _) => {
                return this.client.updateDevice(homeId, device.deviceId, { deviceName: ''+value })
                    .then(device => device.deviceName)
            });
        accessory.context = context;
        return accessory;
    }
}