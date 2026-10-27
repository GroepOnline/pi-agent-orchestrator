/**
 * Defensive shim for environments where os.networkInterfaces() fails
 * (e.g. restricted self-hosted runners with netns/seccomp/netlink limits).
 * Remotion's getPortConfig calls networkInterfaces; without a fallback the
 * whole render aborts with ERR_SYSTEM_ERROR / uv_interface_addresses 97.
 *
 * Loaded via NODE_OPTIONS=--import so it applies to the Remotion CLI process.
 */
import os from 'node:os';

const original = os.networkInterfaces.bind(os);

os.networkInterfaces = function networkInterfacesWithFallback() {
  try {
    return original();
  } catch (err) {
    // Prefer a minimal loopback interface so callers that pick a non-internal
    // address still get a usable result instead of crashing.
    if (process.env.REMOTION_NETWORK_SHIM_DEBUG === '1') {
      console.warn(
        '[remotion-network-shim] os.networkInterfaces() failed; using loopback fallback:',
        err instanceof Error ? err.message : err,
      );
    }
    return {
      lo: [
        {
          address: '127.0.0.1',
          netmask: '255.0.0.0',
          family: 'IPv4',
          mac: '00:00:00:00:00:00',
          internal: true,
          cidr: '127.0.0.1/8',
        },
        {
          address: '::1',
          netmask: 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
          family: 'IPv6',
          mac: '00:00:00:00:00:00',
          internal: true,
          cidr: '::1/128',
          scopeid: 0,
        },
      ],
    };
  }
};
