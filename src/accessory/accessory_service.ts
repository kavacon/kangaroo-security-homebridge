import {Device, DeviceType, KangarooContext} from "../model";
import {VideoDoorbellService} from "./video_doorbell";
import {Logging, PlatformAccessory, API, HAP, Categories, CharacteristicValue} from "homebridge";
import {getDevice, updateDevice} from "../client";

export class AccessoryService {
    private readonly log: Logging;
    private api: API;
    private readonly hap: HAP;
    private readonly videoDoorbellService: VideoDoorbellService;

    constructor(log: Logging, api: API, hap: HAP) {
        this.log = log;
        this.api = api;
        this.hap = hap;
        this.videoDoorbellService = new VideoDoorbellService(log, hap)
    }

    fromDevice(device: Device, homeId: string): { accessory: PlatformAccessory<KangarooContext>; cleanup?: () => void } {
        this.log.info("Creating Accessory with Name : [%s], device type : [%s], Firmware: [%s] ",
            device.deviceName, device.deviceType, device.fwVersion);

        switch (device.deviceType) {
            case DeviceType.DOORCAM:
                const accessory = this.buildBasicAccessory(device, homeId, Categories.VIDEO_DOORBELL)
                return this.videoDoorbellService.configure(device, accessory)
            default:
                throw new Error(`unknown device type" ${device.deviceType}`);
        }
    }

    updateAccessory(accessory: PlatformAccessory<KangarooContext>): Promise<{ accessory: PlatformAccessory<KangarooContext>; cleanup?: () => void }> {
        const res = getDevice(accessory.context.homeId, accessory.context.deviceId);
        return res.then( device => {
            const service = accessory.getService(this.hap.Service.AccessoryInformation);
            service?.getCharacteristic(this.hap.Characteristic.FirmwareRevision).updateValue(''+device.fwVersion)
            service?.getCharacteristic(this.hap.Characteristic.Name).updateValue(device.deviceName)

            switch (device.deviceType) {
                case DeviceType.DOORCAM:
                    return this.videoDoorbellService.update(device, accessory)
                default:
                    throw new Error(`unknown device type" ${device.deviceType}`);
            }
        })
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
                return updateDevice(homeId, device.deviceId, { deviceName: ''+value })
                    .then(device => device.deviceName)
            });
        this.log.warn(`information ${accessoryInformation.UUID}`);
        accessory.context = context;
        return accessory;
    }
}