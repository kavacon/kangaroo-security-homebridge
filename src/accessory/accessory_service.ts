import {Device, DeviceType, KangarooContext} from "../model";
import {VideoDoorbellService} from "./video_doorbell";
import {Logging, PlatformAccessory, API, HAP, Categories, CharacteristicValue} from "homebridge";
import {Client} from "../client/client";
import {NotificationService} from "../notification/notification_service";

export class AccessoryService {
    private readonly log: Logging;
    private api: API;
    private readonly hap: HAP;
    private readonly client: Client
    private readonly videoDoorbellService: VideoDoorbellService;
    private shutdownActions: (() => void)[] = []

    constructor(log: Logging, api: API, hap: HAP, client: Client, notificationService: NotificationService) {
        this.log = log;
        this.api = api;
        this.hap = hap;
        this.client = client;
        this.videoDoorbellService = new VideoDoorbellService(log, hap, client, notificationService)
    }

    fromDevice(device: Device, homeId: string): PlatformAccessory<KangarooContext> {
        this.log.info("Creating Accessory with Name : [%s], device type : [%s], Firmware: [%s] ",
            device.deviceName, device.deviceType, device.fwVersion);

        switch (device.deviceType) {
            case DeviceType.DOORCAM:
                const baseAccessory = this.buildBasicAccessory(device, homeId, Categories.VIDEO_DOORBELL)
                const {accessory, cleanup } = this.videoDoorbellService.configure(device, baseAccessory)
                this.shutdownActions.push(cleanup);
                return accessory;
            default:
                throw new Error(`unknown device type" ${device.deviceType}`);
        }
    }

    updateAccessory(baseAccessory: PlatformAccessory<KangarooContext>): Promise<PlatformAccessory<KangarooContext>> {
        const res = this.client.getDevice(baseAccessory.context.homeId, baseAccessory.context.deviceId);
        return res.then( device => {
            const service = baseAccessory.getService(this.hap.Service.AccessoryInformation);
            service?.getCharacteristic(this.hap.Characteristic.FirmwareRevision).updateValue(''+device.fwVersion)
            service?.getCharacteristic(this.hap.Characteristic.Name).updateValue(device.deviceName)

            switch (device.deviceType) {
                case DeviceType.DOORCAM:
                    const {accessory, cleanup } = this.videoDoorbellService.update(device, baseAccessory)
                    this.shutdownActions.push(cleanup);
                    return accessory;
                default:
                    throw new Error(`unknown device type" ${device.deviceType}`);
            }
        })
    }

    onShutdown() {
        this.shutdownActions.forEach( action => action());
    }

    private buildBasicAccessory(device: Device, homeId: string, category: Categories): PlatformAccessory<KangarooContext> {
        const context: KangarooContext = {
            homeId,
            deviceId: device.deviceId,
            deviceType: device.deviceType,
        }
        const uuid = device.deviceId.replace('D_', '');
        const accessory: PlatformAccessory<KangarooContext> = new this.api.platformAccessory(device.deviceName, uuid, category);
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