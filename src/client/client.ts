import {Account, Alarm, Device} from "../model";
import {Logging} from "homebridge";
import {AuthManager} from "./auth_manager";
import {fetch, HttpMethod} from "./fetch";

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
    }

    private async send<T>(url: string, method: HttpMethod, body?: any, isRetry: boolean = false): Promise<T> {
        try {
            const authToken = await this.authManager.getAuthToken()
            const res = await fetch<T>(url, method,
                {
                    'Content-Type': 'application/json',
                    'X-Authorization': authToken,
                }, body);
            this.log.info(`Completed ${method} ${url}`);
            this.log.debug(`Response: ${res}`)
            return res;
        } catch (err) {
            if (isRetry) {
                this.log.error(`Retry failed error on ${method} ${url} with message [${err}]`)
                throw err;
            } else {
                this.log.error(`Encountered error on ${method} ${url} [${err}]`)
                this.log.warn(`Suspect authorisation expired for ${method} ${url} invalidating token and retrying`)
                this.authManager.refresh();
                return this.send(url, method, body, true);
            }
        }
    }
}