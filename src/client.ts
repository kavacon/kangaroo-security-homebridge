import fetch from 'node-fetch';
import {Account, Alarm, Device} from "./model";

const BASE_URL = 'https://api.heykangaroo.com/v1/me'

function send(url: string, method: string, body?: string): Promise<string> {
    return fetch(url, {
        method,
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body)
    });
}

export function devicesAndTags(homeId: string): Promise<Device[]> {
    return send(`${BASE_URL}/homes/${homeId}/devicesAndTags`, 'GET')
        .then(result => JSON.parse(result))
}

export function device(homeId: string, deviceId: string): Promise<Device> {
    return send(`${BASE_URL}/homes/${homeId}/devices/${deviceId}`, 'GET')
        .then(result => JSON.parse(result))
}

export function nonDismissedAlarms(homeId: string): Promise<Alarm[]> {
    return send(`${BASE_URL}/homes/${homeId}/alarms/nondismissed`, 'GET')
        .then(result => JSON.parse(result))
}

export function account(): Promise<Account> {
    return send(BASE_URL, 'POST')
        .then(result => JSON.parse(result))
}