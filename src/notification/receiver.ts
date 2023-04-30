import {Device} from "../model";

export interface DeviceReceiver {
    (device: Device, homeId: string): void
}

export interface DeviceDeleter {
    (device: string): void
}