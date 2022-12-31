import fetch from 'node-fetch';
import {Account, Alarm, Device} from "./model";
import {Logging} from "homebridge";

const BASE_URL = 'https://api.heykangaroo.com/v1/me'
let authToken = '';
let log: Logging;

function send<T>(url: string, method: string, body?: any): Promise<T> {
    return fetch(url, {
        method,
        headers: {
            'Content-Type': 'application/json',
            'X-Authorization': authToken,
        },
        body: JSON.stringify(body)
    }).then( result => result.json());
}

export function devicesAndTags(homeId: string): Promise<Device[]> {
    return send(`${BASE_URL}/homes/${homeId}/devicesAndTags`, 'GET')
}

export function getDevice(homeId: string, deviceId: string): Promise<Device> {
    return send(`${BASE_URL}/homes/${homeId}/devices/${deviceId}`, 'GET')
}

export function updateDevice(homeId: string, deviceId: string, update: Partial<Device>): Promise<Device> {
    return send(`${BASE_URL}/homes/${homeId}/devices/${deviceId}`, 'PUT', update)
}

export function updateDeviceCam(homeId: string, deviceId: string, update: Partial<Device>): Promise<Device> {
    return send<Device>(`${BASE_URL}/homes/${homeId}/devices/${deviceId}/doorCamAlertSetting`, 'PUT', update)
}

export function nonDismissedAlarms(homeId: string): Promise<Alarm[]> {
    return send<Alarm[]>(`${BASE_URL}/homes/${homeId}/alarms/nondismissed`, 'GET')
}

export function account(): Promise<Account> {
    return send<Account>(BASE_URL, 'GET')
        .then(result => {log.debug(JSON.stringify(result, null, 4)); return result})
}

export function updateAuth(token: string) {
    authToken = token;
}

export function setLog(logging: Logging) {
    log = logging
}