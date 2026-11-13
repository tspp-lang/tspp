/**
 * Copyright (C) 2023 TypeFox and others.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { LspDocument } from '../document.js';

export const typescript = 'typescript';
export const typescriptreact = 'typescriptreact';
export const javascript = 'javascript';
export const javascriptreact = 'javascriptreact';
export const jsxTags = 'jsx-tags';
export const tspp = 'tspp'; // TSPP-SLOT(tspp-language)

export const jsTsLanguageModes = [
    javascript,
    javascriptreact,
    typescript,
    typescriptreact,
    tspp, // TSPP-SLOT(tspp-language)
];

export function isSupportedLanguageMode(doc: LspDocument): boolean {
    return [typescript, typescriptreact, javascript, javascriptreact, tspp].includes(doc.languageId) || isTsppConfigDocument(doc); // TSPP-SLOT(tspp-language)
}

// TSPP-SLOT(tspp-config-jsonc): Keep configuration documents in the JSON language service while syncing their text.
export function isTsppConfigDocument(doc: { languageId: string; filepath: string; }): boolean {
    return ['json', 'jsonc'].includes(doc.languageId) && /(?:^|[/\\])tsppconfig(?:\.[^/\\]+)?\.json$/i.test(doc.filepath);
}

export function isTypeScriptDocument(doc: LspDocument): boolean {
    return [typescript, typescriptreact, tspp].includes(doc.languageId); // TSPP-SLOT(tspp-language)
}
