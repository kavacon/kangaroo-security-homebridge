import fetch from 'node-fetch';
import {Account, Alarm, Device} from "../model";
import {Logging} from "homebridge";
import {AuthManager} from "./auth_manager";

const BASE_URL = 'https://api.heykangaroo.com/v1/me'

export class Client {
    private readonly log: Logging;
    private readonly authManager: AuthManager;

    constructor(log: Logging, authManager: AuthManager) {
        this.log = log;
        this.authManager = authManager;
    }

    devicesAndTags(homeId: string): Promise<Device[]> {
        return this.send(`${BASE_URL}/homes/${homeId}/devicesAndTags`, 'GET')
    }

    getDevice(homeId: string, deviceId: string): Promise<Device> {
        return this.send(`${BASE_URL}/homes/${homeId}/devices/${deviceId}`, 'GET')
    }

    updateDevice(homeId: string, deviceId: string, update: Partial<Device>): Promise<Device> {
        return this.send(`${BASE_URL}/homes/${homeId}/devices/${deviceId}`, 'PUT', update)
    }

    updateDeviceCam(homeId: string, deviceId: string, update: Partial<Device>): Promise<Device> {
        return this.send<Device>(`${BASE_URL}/homes/${homeId}/devices/${deviceId}/doorCamAlertSetting`, 'PUT', update)
    }

    nonDismissedAlarms(homeId: string): Promise<Alarm[]> {
        return this.send<Alarm[]>(`${BASE_URL}/homes/${homeId}/alarms/nondismissed`, 'GET')
    }

    account(): Promise<Account> {
        return this.send<Account>(BASE_URL, 'GET')
            .then(result => {
                this.log.debug('account call completed');
                return result
            })
    }

    private send<T>(url: string, method: string, body?: any): Promise<T> {
        return this.authManager.getAuthToken()
            .then(authToken =>
                fetch(url, {
                    method,
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Authorization': authToken,
                    },
                    body: JSON.stringify(body)
                })
            ).then(result => result.json());
    }
}