import _ = require('lodash');
import net = require('net');
import tls = require('tls');
import http = require('http');
import httpolyglot = require('@httptoolkit/httpolyglot');

import { TlsRequest } from '../types';
import { destroyable, DestroyableServer } from '../util/destroyable-server';
import { getCA, CAOptions } from '../util/tls';
import { peekFirstByte, mightBeTLSHandshake } from '../util/socket-util';

// Hardcore monkey-patching: force TLSSocket to link servername & remoteAddress to
// sockets as soon as they're available, without waiting for the handshake to fully
// complete, so we can easily access them if the handshake fails.
const originalSocketInit = (<any>tls.TLSSocket.prototype)._init;
(<any>tls.TLSSocket.prototype)._init = function () {
    originalSocketInit.apply(this, arguments);

    const tlsSocket = this;
    const loadSNI = tlsSocket._handle.oncertcb;
    tlsSocket._handle.oncertcb = function (info: any) {
        tlsSocket.initialRemoteAddress = tlsSocket._parent.remoteAddress;
        tlsSocket.servername = info.servername;
        return loadSNI.apply(this, arguments);
    };
};

export type ComboServerOptions = { debug: boolean, https?: CAOptions };

// Takes an established TLS socket, calls the error listener if it's silently closed
function ifTlsDropped(socket: tls.TLSSocket, errorCallback: () => void) {
    new Promise((resolve, reject) => {
        socket.once('data', resolve);
        socket.once('close', reject);
        socket.once('end', reject);
    })
    .then(() => {
        // Mark the socket as having completed TLS setup - this ensures that future
        // errors fire as client errors, not TLS setup errors.
        socket.tlsSetupCompleted = true;
    })
    .catch(() => {
        // To get here, the socket must have connected & done the TLS handshake, but then
        // closed/ended without ever sending any data. We can fairly confidently assume
        // in that case that it's rejected our certificate.
        errorCallback();
    });
}

function getCauseFromError(error: Error & { code?: string }) {
    const cause = (/alert certificate/.test(error.message) || /alert unknown ca/.test(error.message))
        // The client explicitly told us it doesn't like the certificate
        ? 'cert-rejected'
    : /no shared cipher/.test(error.message)
        // The client refused to negotiate a cipher. Probably means it didn't like the
        // cert so refused to continue, but it could genuinely not have a shared cipher.
        ? 'no-shared-cipher'
    : (/ECONNRESET/.test(error.message) || error.code === 'ECONNRESET')
        // The client sent no TLS alert, it just hard RST'd the connection
        ? 'reset'
    : 'unknown'; // Something else.

    if (cause === 'unknown') console.log('Unknown TLS error:', error);

    return cause;
}

// The low-level server that handles all the sockets & TLS. The server will correctly call the
// given handler for both HTTP & HTTPS direct connections, or connections when used as an
// either HTTP or HTTPS proxy, all on the same port.
export async function createComboServer(
    options: ComboServerOptions,
    requestListener: (req: http.IncomingMessage, res: http.ServerResponse) => void,
    tlsClientErrorListener: (socket: tls.TLSSocket, req: TlsRequest) => void
): Promise<DestroyableServer> {
    if (!options.https) {
        return destroyable(http.createServer(requestListener));
    }

    const ca = await getCA(options.https!);
    const defaultCert = ca.generateCertificate('localhost');

    const server = httpolyglot.createServer({
        key: defaultCert.key,
        cert: defaultCert.cert,
        ca: [defaultCert.ca],
        SNICallback: (domain: string, cb: Function) => {
            if (options.debug) console.log(`Generating certificate for ${domain}`);

            try {
                const generatedCert = ca.generateCertificate(domain);
                cb(null, tls.createSecureContext({
                    key: generatedCert.key,
                    cert: generatedCert.cert,
                    ca: generatedCert.ca
                }));
            } catch (e) {
                console.error('Cert generation error', e);
                cb(e);
            }
        }
    }, requestListener);

    server.on('tlsClientError', (error: Error, socket: tls.TLSSocket) => {
        // These only work because of oncertcb monkeypatch above
        tlsClientErrorListener(socket, {
            failureCause: getCauseFromError(error),
            hostname: socket.servername,
            remoteIpAddress: socket.initialRemoteAddress!,
            tags: []
        });
    });
    server.on('secureConnection', (socket: tls.TLSSocket) =>
        ifTlsDropped(socket, () => {
            tlsClientErrorListener(socket, {
                failureCause: 'closed',
                hostname: socket.servername,
                remoteIpAddress: socket.remoteAddress!,
                tags: []
            });
        })
    );

    // If the server receives a HTTP/HTTPS CONNECT request, do some magic to proxy & intercept it
    server.addListener('connect', (req: http.IncomingMessage, socket: net.Socket) => {
        const [ targetHost, port ] = req.url!.split(':');
        if (options.debug) console.log(`Proxying CONNECT to ${targetHost}`);

        socket.once('error', (e) => console.log('Error on client socket', e));

        socket.write('HTTP/' + req.httpVersion + ' 200 OK\r\n\r\n', 'utf-8', async () => {
            const firstByte = await peekFirstByte(socket);

            // Tell later handlers whether the socket wants an insecure upstream
            socket.upstreamEncryption = mightBeTLSHandshake(firstByte);

            if (socket.upstreamEncryption) {
                if (options.debug) console.log(`Unwrapping TLS connection to ${targetHost}`);
                unwrapTLS(targetHost, port, socket);
            } else {
                // Non-TLS CONNECT, probably a plain HTTP websocket. Pass it through untouched.
                if (options.debug) console.log(`Passing through connection to ${targetHost}`);
                server.emit('connection', socket);
                socket.resume();
            }
        });
    });

    async function unwrapTLS(targetHost: string, port: string, rawSocket: net.Socket) {
        const generatedCert = ca.generateCertificate(targetHost);

        let tlsSocket = new tls.TLSSocket(rawSocket, {
            isServer: true,
            server: server,
            secureContext: tls.createSecureContext({
                key: generatedCert.key,
                cert: generatedCert.cert,
                ca: generatedCert.ca
            }),
            ALPNProtocols: ['http/1.1']
        });

        // Wait for:
        // * connect, not dropped -> all good
        // * _tlsError before connect -> cert rejected
        // * sudden end before connect -> cert rejected
        await new Promise((resolve, reject) => {
            tlsSocket.on('secure', async () => {
                ifTlsDropped(tlsSocket, () => {
                    tlsClientErrorListener(tlsSocket, {
                        failureCause: 'closed',
                        hostname: targetHost,
                        remoteIpAddress: rawSocket.remoteAddress!,
                        tags: []
                    });
                });

                peekFirstByte(tlsSocket).then(resolve);
            });
            tlsSocket.on('_tlsError', (error) => {
                reject(getCauseFromError(error));
            });
            tlsSocket.on('end', () => {
                // Delay, so that simultaneous specific errors reject first
                setTimeout(() => reject('closed'), 1);
            });
        }).catch((cause) => tlsClientErrorListener(tlsSocket, {
            failureCause: cause,
            hostname: targetHost,
            remoteIpAddress: rawSocket.remoteAddress!,
            tags: []
        }));

        // This is a little crazy, but only a little. We create a one-off server to handle HTTP parsing, but
        // never listen on any ports or anything, we just hand it a live socket. Setup is pretty cheap here
        // (instantiate, sets up as event emitter, registers some events & properties, that's it), and
        // this is the easiest way I can see to put targetHost into the URL, without reimplementing HTTP.
        const innerServer = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
            // Request URIs are usually relative here, but can be * (OPTIONS) or absolute (odd people) in theory
            if (req.url !== '*' && req.url![0] === '/') {
                req.url = `https://${targetHost}:${port}${req.url}`;
            }
            return requestListener(req, res);
        });
        innerServer.addListener('upgrade', (req, socket, head) => {
            req.url = `https://${targetHost}:${port}${req.url}`;
            server.emit('upgrade', req, socket, head);
        });
        innerServer.addListener('connect', (req, res) => server.emit('connect', req, res));

        innerServer.on('clientError', (...args) => server.emit('clientError', ...args));

        innerServer.emit('connection', tlsSocket);
        tlsSocket.resume(); // Socket was paused by peekFirstByte() above
    }

    return destroyable(server);
}