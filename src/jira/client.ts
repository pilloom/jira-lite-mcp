import axios, { type AxiosInstance } from 'axios';

import { requireJiraConfig } from '../config/env.js';

export function createJiraClient(): AxiosInstance {
    const config = requireJiraConfig();

    return axios.create({
        baseURL: config.jiraUrl,
        auth: {
            username: config.jiraEmail,
            password: config.jiraToken,
        },
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
        },
    });
}