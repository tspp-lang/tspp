import { describe, expect, it } from 'vitest';
import type { LspDocument } from '../document.js';
import { isSupportedLanguageMode, isTypeScriptDocument, jsTsLanguageModes, tspp } from './languageIds.js';

describe('TS++ language mode', () => {
    const document = { languageId: tspp } as LspDocument;

    it('registers tspp as a supported JavaScript/TypeScript-family mode', () => {
        expect(jsTsLanguageModes).toContain(tspp);
        expect(isSupportedLanguageMode(document)).toBe(true);
    });

    it('routes tspp documents through TypeScript language features', () => {
        expect(isTypeScriptDocument(document)).toBe(true);
    });
});
