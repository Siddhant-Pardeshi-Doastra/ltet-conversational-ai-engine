// Labelled demo credential shared by the seeder and the demo role switcher.
// Synthetic demo users only; production deployments must provision real
// credentials via the approved identity process (SEC-05). The value is
// env-overridable so a workspace can rotate it without a code change.
export const DEMO_STAFF_PASSWORD = process.env.DEMO_STAFF_PASSWORD || 'Demo#Pass1';
