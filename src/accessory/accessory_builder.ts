import {Device, DeviceType, KangarooContext} from "../model";
import video_doorbell from "./video_doorbell";
import {Logging, PlatformAccessory, Service, API, HAP, Categories} from "homebridge";

export class AccessoryBuilder {
    private readonly log: Logging;
    private api: API;
    private readonly hap: HAP;
    private readonly homeId: string;
    private readonly tempStorage: string;

    constructor(log: Logging, api: API, hap: HAP, homeId: string, tempStorage: string) {
        this.log = log;
        this.api = api;
        this.hap = hap;
        this.homeId = homeId;
        this.tempStorage = tempStorage
    }

    fromDevice(device: Device): { accessory: PlatformAccessory<KangarooContext>; cleanup?: () => void } {
        this.log.info("Creating Accessory with Name : [%s], device type : [%s], Firmware: [%s] ",
            device.deviceName, device.deviceType, device.fwVersion);

        switch (device.deviceType) {
            case DeviceType.DOORCAM:
                const accessory = this.buildBasicAccessory(device, Categories.VIDEO_DOORBELL)
                return video_doorbell(this.log, this.hap, this.tempStorage, device, accessory)
            default:
                throw new Error(`unknown device type" ${device.deviceType}`);
        }
    }

    private buildBasicAccessory(device: Device, category: Categories): PlatformAccessory<KangarooContext> {
        const context: KangarooContext = {
            homeId: this.homeId,
            deviceId: device.deviceId,
            deviceType: device.deviceType,
        }
        const uuid = device.deviceId.replace('D_', '');
        const accessoryInformation: Service = new this.hap.Service.AccessoryInformation();
        accessoryInformation
            .setCharacteristic(this.hap.Characteristic.Name, device.deviceName)
            .setCharacteristic(this.hap.Characteristic.SerialNumber, device.serialNumber)
            .setCharacteristic(this.hap.Characteristic.Manufacturer, 'kangaroo')
            .setCharacteristic(this.hap.Characteristic.Model, device.deviceModel)
            .setCharacteristic(this.hap.Characteristic.FirmwareRevision, device.fwVersion);
        const accessory: PlatformAccessory<KangarooContext> = new this.api.platformAccessory(device.deviceName, uuid, category);
        accessory.addService(accessoryInformation);
        accessory.context = context;
        return accessory;
    }
}