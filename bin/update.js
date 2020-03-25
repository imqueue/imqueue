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
const { resolve } = require('path');

const depsJson = process.argv[2];
const pkgPath = resolve(process.env.INIT_CWD, 'package.json');
const errLog = resolve(process.env.INIT_CWD, 'imq-install-error.log');
const infoLog = resolve(process.env.INIT_CWD, 'imq-install.log');
const encoding = 'utf8';

try {
    const deps = JSON.parse(depsJson);
    const pkg = require(pkgPath);

    if (deps) {
        pkg.dependencies = deps;
        writeFileSync(
            pkgPath,
            JSON.stringify(pkg, null, 2),
            { encoding },
        );
    }
    writeFileSync(
        infoLog,
        `Saved '${ depsJson }' to '${ pkgPath }'!\n`,
        { encoding }
    )
} catch (err) {
    writeFileSync(
        errLog,
        `Error saving '${ depsJson }' to '${pkgPath}\n${ err.stack }'`,
        { encoding },
    );
}
