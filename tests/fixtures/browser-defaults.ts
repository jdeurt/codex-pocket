export const BROWSER_ORIGIN = process.env.POCKET_BROWSER_TEST_ORIGIN ?? "http://127.0.0.1:3101";
export const AGENT_ORIGIN = process.env.POCKET_AGENT_TEST_ORIGIN ?? "http://127.0.0.1:3107";
export const SPINNER_ORIGIN = process.env.POCKET_SPINNER_TEST_ORIGIN ?? "http://127.0.0.1:3103";
export const UPLOAD_ORIGIN = process.env.POCKET_UPLOAD_TEST_ORIGIN ?? "http://127.0.0.1:3118";
export const PHONE_WIDTH = 390;
export const PHONE_HEIGHT = 844;
export const DESKTOP_WIDTH = 1280;
export const DESKTOP_HEIGHT = 900;
export const NARROW_WIDTH = 320;
export const SAFARI_WIDTH = 1024;
export const SAFARI_HEIGHT = 768;
export const PHONE = { viewport: { width: PHONE_WIDTH, height: PHONE_HEIGHT }, isMobile: true, hasTouch: true };
export const DESKTOP = { viewport: { width: DESKTOP_WIDTH, height: DESKTOP_HEIGHT } };

export const POCKETS_ORIGIN = "http://127.0.0.1:3467";
