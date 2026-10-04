import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/cli';

describe('CLI argument parsing', () => {
  it('applies defaults', () => {
    const { options } = parseArgs(['--no-static'], { SONGDECK_DATA_DIR: '/tmp/sd-data' });
    expect(options.port).toBeUndefined();
    expect(options.host).toBeUndefined();
    expect(options.dataDir).toBe(path.resolve('/tmp/sd-data'));
    expect(options.staticDir).toBeUndefined();
    expect(options.allowOrigins).toBeUndefined();
  });

  it('parses all flags, both "--flag value" and "--flag=value"', () => {
    const { options } = parseArgs(
      [
        '--port',
        '9000',
        '--host=0.0.0.0',
        '--data-dir',
        'data',
        '--token',
        's3cret',
        '--allow-origin',
        'http://a.test',
        '--allow-origin=http://b.test',
        '--no-persist',
        '--workers',
        '2',
        '--node-name',
        'studio-pc',
        '--no-static',
        '--log-level',
        'debug',
      ],
      {},
    );
    expect(options).toMatchObject({
      port: 9000,
      host: '0.0.0.0',
      dataDir: path.resolve('data'),
      token: 's3cret',
      allowOrigins: ['http://a.test', 'http://b.test'],
      persist: false,
      render: { workers: 2 },
      nodeName: 'studio-pc',
      logLevel: 'debug',
    });
  });

  it('requires a token for non-loopback hosts (flag or SONGDECK_TOKEN)', () => {
    expect(() => parseArgs(['--host', '0.0.0.0', '--no-static'], {})).toThrow(/--token is required/);
    expect(parseArgs(['--host', '0.0.0.0', '--no-static'], { SONGDECK_TOKEN: 'abc' }).options.token).toBe(
      'abc',
    );
    expect(() => parseArgs(['--host', '127.0.0.1', '--no-static'], {})).not.toThrow();
    expect(() => parseArgs(['--host', '::1', '--no-static'], {})).not.toThrow();
  });

  it('rejects bad values and unknown flags', () => {
    expect(() => parseArgs(['--port', 'abc'], {})).toThrow(/--port/);
    expect(() => parseArgs(['--port'], {})).toThrow(/needs a value/);
    expect(() => parseArgs(['--vault', 'cloud'], {})).toThrow(/--vault/);
    expect(() => parseArgs(['--frobnicate'], {})).toThrow(/Unknown option/);
    expect(() => parseArgs(['--static', '/definitely/not/here'], {})).toThrow(/does not exist/);
  });

  it('handles --help and --version', () => {
    expect(parseArgs(['--help', '--no-static'], {}).help).toBe(true);
    expect(parseArgs(['--version', '--no-static'], {}).version).toBe(true);
  });
});
