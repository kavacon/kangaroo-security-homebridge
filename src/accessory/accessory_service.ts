import {Device, DeviceType, KangarooContext} from "../model";
import {configureVideoDoorbell, updateVideoDoorbell} from "./video_doorbell";
import {Logging, PlatformAccessory, Service, API, HAP, Categories} from "homebridge";
import {getDevice} from "../client";

export class AccessoryService {
    private readonly log: Logging;
    private api: API;
    private readonly hap: HAP;
    private readonly tempStorage: string;

    constructor(log: Logging, api: API, hap: HAP, tempStorage: string) {
        this.log = log;
        this.api = api;
        this.hap = hap;
        this.tempStorage = tempStorage
    }

    fromDevice(device: Device, homeId: string): { accessory: PlatformAccessory<KangarooContext>; cleanup?: () => void } {
        this.log.info("Creating Accessory with Name : [%s], device type : [%s], Firmware: [%s] ",
            device.deviceName, device.deviceType, device.fwVersion);

        switch (device.deviceType) {
            case DeviceType.DOORCAM:
                const accessory = this.buildBasicAccessory(device, homeId, Categories.VIDEO_DOORBELL)
                return configureVideoDoorbell(this.log, this.hap, this.tempStorage, device, accessory)
            default:
                throw new Error(`unknown device type" ${device.deviceType}`);
        }
    }

    updateAccessory(accessory: PlatformAccessory<KangarooContext>): Promise<{ accessory: PlatformAccessory<KangarooContext>; cleanup?: () => void }> {
        const res = getDevice(accessory.context.homeId, accessory.context.deviceId);
        return res.then( device => {
            const service = accessory.getService(this.hap.Service.AccessoryInformation);
            service?.getCharacteristic(this.hap.Characteristic.FirmwareRevision).updateValue(device.fwVersion)
            service?.getCharacteristic(this.hap.Characteristic.Name).updateValue(device.deviceName)

            switch (device.deviceType) {
                case DeviceType.DOORCAM:
                    return updateVideoDoorbell(this.log, this.hap, this.tempStorage, device, accessory)
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