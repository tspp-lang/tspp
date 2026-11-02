import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { findPathToModule } from './modules-resolver.js';
import { MODULE_FOLDERS } from '../tsServer/versionProvider.js';

// A project of its own, because where a package manager puts `typescript` in this workspace depends on what else needs it.
const root = mkdtempSync(join(tmpdir(), 'tspp-modules-resolver-'));
const modulePath = resolve(root, MODULE_FOLDERS[0]);
const nested = join(root, 'src', 'utils');
mkdirSync(modulePath, { recursive: true });
mkdirSync(nested, { recursive: true });

describe('findPathToModule', () => {
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    it('resolves tsserver in own directory', () => {
        expect(findPathToModule(root, MODULE_FOLDERS)).toBe(modulePath);
    });
    it('resolves tsserver in parent directory', () => {
        expect(findPathToModule(nested, MODULE_FOLDERS)).toBe(modulePath);
    });
});
