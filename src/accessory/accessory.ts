import {
    CharacteristicGetHandler,
    CharacteristicSetHandler,
    CharacteristicValue,
    HAP,
    Logging,
    Nullable,
    PlatformAccessory, PlatformConfig
} from "homebridge";
import {Device, KangarooContext} from "../model";
import {Client} from "../client/client";

export abstract class Accessory {
    readonly platformAccessory: PlatformAccessory<KangarooContext>
    protected readonly hap: HAP;
    protected readonly log: Logging;
    private readonly client: Client
    protected device: Device;

    constructor(platformAccessory: PlatformAccessory<KangarooContext>, device: Device, hap: HAP, log: Logging, client: Client) {
        this.platformAccessory = platformAccessory;
        this.device = device;
        this.hap = hap;
        this.log = log;
        this.client = client;
    }

    getDeviceId(): string {
        return this.platformAccessory.context.deviceId;
    }
    onUpdate(device: Device, homeId: string) {
        this.log.info(`update received for device ${device.deviceId} ${device.deviceName}`);
        this.device = device;
        this.processDeviceUpdate(device)
    }

    protected loggedGet(label: string, getter: () => Nullable<CharacteristicValue>): CharacteristicGetHandler {
        return () => {
            this.log.info('getting characteristic %s for %s', label, this.platformAccessory.displayName)
            return getter()
        };
    }

    protected updatingSet(label: string, deviceUpdateBuilder: (value) => Partial<Device>): CharacteristicSetHandler {
        const {context} = this.platformAccessory;
        return (value) => {
            this.log.info(`setting ${label} for device ${this.platformAccessory.displayName} requested ${!!value}`);
            return this.client.updateDeviceCam(context.homeId, context.deviceId, deviceUpdateBuilder(value))
                .then(res => {
                    this.device = res;
                })
                .catch(reason => {
                    this.log.error('failed to set characteristic value %s for %s with error %s', value, this.getDeviceId(), reason);
                    return null
                })
        };
    }

    abstract initialise(config?: PlatformConfig);

    protected abstract processDeviceUpdate(device: Device): void;

    abstract onRemove(): void;
}