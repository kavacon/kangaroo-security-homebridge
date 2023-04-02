import path from "path";

export const enum Resource {
    PLACEHOLDER = 'loading.gif'
}

export function getResourcePath(resource: Resource): string {
    return path.join(__dirname, 'resources', resource);
}