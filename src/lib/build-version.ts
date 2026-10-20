// Next replaces this expression in both bundles; starting a build never changes its identity.
export const BUILD_VERSION = process.env.NEXT_PUBLIC_POCKET_BUILD_VERSION ?? "development";
export const CONNECTION_LOST_EVENT = "pocket-connection-lost";
