import { describe, expect, it } from 'vitest';

import { availableNetworkModeFor, connectionUrlForMode } from './ConnectPhoneModal';

const remoteAccess = {
  enabled: true,
  url: 'http://192.168.1.20:7777?token=abc',
  wifiUrl: 'http://192.168.1.20:7777?token=abc',
  tailscaleUrl: 'http://100.64.1.2:7777?token=abc',
  publicUrl: null,
};

describe('connectionUrlForMode', () => {
  it('returns null while remote access is disabled', () => {
    expect(connectionUrlForMode({ ...remoteAccess, enabled: false }, 'wifi')).toBeNull();
  });

  it('uses the selected network URL when available', () => {
    expect(connectionUrlForMode(remoteAccess, 'wifi')).toBe(remoteAccess.wifiUrl);
    expect(connectionUrlForMode(remoteAccess, 'tailscale')).toBe(remoteAccess.tailscaleUrl);
  });

  it('falls back to the server URL when the selected network URL is missing', () => {
    expect(connectionUrlForMode({ ...remoteAccess, wifiUrl: null }, 'wifi')).toBe(remoteAccess.url);
    expect(connectionUrlForMode({ ...remoteAccess, tailscaleUrl: null }, 'tailscale')).toBe(
      remoteAccess.url,
    );
  });
});

describe('availableNetworkModeFor', () => {
  it('keeps the current network mode while it is available', () => {
    expect(availableNetworkModeFor(remoteAccess, 'wifi')).toBe('wifi');
    expect(availableNetworkModeFor(remoteAccess, 'tailscale')).toBe('tailscale');
  });

  it('switches to an available mode when the current mode is unavailable', () => {
    expect(availableNetworkModeFor({ ...remoteAccess, wifiUrl: null }, 'wifi')).toBe('tailscale');
    expect(availableNetworkModeFor({ ...remoteAccess, tailscaleUrl: null }, 'tailscale')).toBe(
      'wifi',
    );
  });

  it('keeps the current mode when only the fallback server URL is known', () => {
    expect(
      availableNetworkModeFor({ ...remoteAccess, wifiUrl: null, tailscaleUrl: null }, 'wifi'),
    ).toBe('wifi');
  });

  it('preserves an explicit public selection even when WiFi/Tailscale are reachable', () => {
    // The user deliberately picked public; the helper must not silently
    // demote them back to WiFi just because WiFi is also available.
    expect(availableNetworkModeFor(remoteAccess, 'public')).toBe('public');
  });

  it('never auto-promotes to public', () => {
    // No WiFi, no Tailscale, but cloudflared is up — the helper still
    // refuses to expose the desktop on the public Internet without an
    // explicit user click.
    const onlyPublic = {
      ...remoteAccess,
      wifiUrl: null,
      tailscaleUrl: null,
      publicUrl: 'https://abc.trycloudflare.com?token=xyz',
    };
    expect(availableNetworkModeFor(onlyPublic, 'wifi')).toBe('wifi');
  });
});

describe('connectionUrlForMode — public', () => {
  it('returns the public URL when public mode is selected and active', () => {
    expect(
      connectionUrlForMode(
        { ...remoteAccess, publicUrl: 'https://abc.trycloudflare.com?token=xyz' },
        'public',
      ),
    ).toBe('https://abc.trycloudflare.com?token=xyz');
  });

  it('returns null in public mode when no public URL is active', () => {
    // Critical: the fallback `remoteAccess.url` would point at the LAN,
    // which is wrong in public mode — must not leak the LAN URL into a
    // QR that the user thinks is Internet-reachable.
    expect(connectionUrlForMode({ ...remoteAccess, publicUrl: null }, 'public')).toBeNull();
  });
});
