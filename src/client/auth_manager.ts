import {Logging} from "homebridge";
import {fetch} from "./fetch";

type AuthResponse = any & { access_token: string };

export class AuthManager {
    private readonly log: Logging;
    private readonly tokenRequest: { refreshToken: string, grantType: string };
    private readonly requestUrl: string;
    private authToken;

    constructor(log: Logging, refreshToken: string, secureTokenKey: string) {
        this.log = log;
        this.tokenRequest = {
            refreshToken,
            grantType: 'refresh_token',
        }
        this.requestUrl = `https://securetoken.googleapis.com/v1/token?key=${secureTokenKey}`;
        this.authToken = this.fetchToken();
    }

    getAuthToken() : Promise<string> {
        return this.authToken
    }

    refresh() {
        this.log.info('auth token refresh requested')
        this.authToken = this.fetchToken();
    }

    private fetchToken(): Promise<string> {
        return fetch<AuthResponse>(this.requestUrl, 'POST', {'Content-Type': 'application/json'},
            this.tokenRequest)
            .then(result => result.access_token);
    }
}