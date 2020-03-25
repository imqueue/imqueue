#!/usr/bin/env bash
/*!
 * Copyright (c) 2018, imqueue.com <support@imqueue.com>
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
 * REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
 * AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
 * INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
 * LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
 * OTHER TORTUOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
 * PERFORMANCE OF THIS SOFTWARE.
 */
const { writeFileSync } = require('fs');
const { dirname, resolve } = require('path');

const depsJson = process.argv[3];
const pkgPath = process.argv[2];
const errLog = resolve(dirname(pkgPath), 'imq-install-error.log');

try {
    const deps = JSON.parse(depsJson);
    const pkg = require(pkgPath);

    if (deps) {
        pkg.dependencies = deps;
        writeFileSync(
            pkgPath,
            JSON.stringify(pkg, null, 2),
            { encoding: 'utf8' },
        );
    }
} catch (err) {
    writeFileSync(
        errLog,
        `Error saving '${ depsJson }' to ${pkgPath}\n${ err.stack }`,
        { encoding: 'utf8' },
    );
}
