﻿import {
	sha256
} from 'js-sha256';
import {
	ec as elliptic
} from 'elliptic';
import {
	ModeOfOperation
} from 'aes-js';
import chacha from 'js-chacha20';
import {
	Buffer
} from 'buffer';
window.Buffer = Buffer;
class NodeCrypt {
	constructor(config = {}, callbacks = {}) {
		this.config = {
			rsaPublic: config.rsaPublic || '',
			wsAddress: config.wsAddress || '',
			reconnectDelay: config.reconnectDelay || 3000,
			pingInterval: config.pingInterval || 20000,
			debug: config.debug || false,
		};
		this.callbacks = {
			onServerClosed: callbacks.onServerClosed || null,
			onServerSecured: callbacks.onServerSecured || null,
			onClientSecured: callbacks.onClientSecured || null,
			onClientList: callbacks.onClientList || null,
			onClientMessage: callbacks.onClientMessage || null,
		};
		this.SERVER_KEY_STORAGE = 'nodecrypt_server_key';
		try {
			this.clientEc = new elliptic('curve25519')
		} catch (error) {
			this.logEvent('constructor', error, 'error')
		}
		this.serverKeys = null;
		this.serverShared = null;
		this.credentials = null;
		this.connection = null;
		this.reconnect = null;
		this.ping = null;
		this.channel = {};
		this.setCredentials = this.setCredentials.bind(this);
		this.connect = this.connect.bind(this);
		this.destruct = this.destruct.bind(this);
		this.onOpen = this.onOpen.bind(this);
		this.onMessage = this.onMessage.bind(this);
		this.onError = this.onError.bind(this);
		this.onClose = this.onClose.bind(this);
		this.logEvent = this.logEvent.bind(this);
		this.isOpen = this.isOpen.bind(this);
		this.isClosed = this.isClosed.bind(this);
		this.startReconnect = this.startReconnect.bind(this);
		this.stopReconnect = this.stopReconnect.bind(this);
		this.startPing = this.startPing.bind(this);
		this.stopPing = this.stopPing.bind(this);
		this.disconnect = this.disconnect.bind(this);
		this.sendMessage = this.sendMessage.bind(this);
		this.sendChannelMessage = this.sendChannelMessage.bind(this);
		this.encryptServerMessage = this.encryptServerMessage.bind(this);
		this.decryptServerMessage = this.decryptServerMessage.bind(this);
		this.encryptClientMessage = this.encryptClientMessage.bind(this);
		this.decryptClientMessage = this.decryptClientMessage.bind(this)
	}
	setCredentials(username, channel, password) {
		this.logEvent('setCredentials');
		try {
			this.credentials = {
				username: username,
				channel: sha256(channel),
				password: sha256(password)
			}
		} catch (error) {
			this.logEvent('setCredentials', error, 'error');
			return (false)
		}
		return (true)
	}
	connect() {
		if (!this.credentials) {
			return (false)
		}
		this.logEvent('connect', this.config.wsAddress);
		this.stopReconnect();
		this.stopPing();
		this.serverKeys = null;
		this.serverShared = null;
		this.channel = {};
		try {
			this.connection = new WebSocket(this.config.wsAddress);
			this.connection.onopen = this.onOpen;
			this.connection.onmessage = this.onMessage;
			this.connection.onerror = this.onError;
			this.connection.onclose = this.onClose
		} catch (error) {
			this.logEvent('connect', error, 'error');
			return (false)
		}
		return (true)
	}
	destruct() {
		this.logEvent('destruct');
		this.stopReconnect();
		this.stopPing();
		this.reconnect = null;
		this.ping = null;
		this.config = {
			rsaPublic: '',
			wsAddress: '',
			reconnectDelay: 3000,
			pingInterval: 15000,
			debug: false,
		};
		this.callbacks.onServerClosed = null;
		this.callbacks.onServerSecured = null;
		this.callbacks.onClientSecured = null;
		this.callbacks.onClientList = null;
		this.callbacks.onClientMessage = null;
		this.clientEc = null;
		this.serverKeys = null;
		this.serverShared = null;
		this.credentials = null;
		this.connection.onopen = null;
		this.connection.onmessage = null;
		this.connection.onerror = null;
		this.connection.onclose = null;
		try {
			this.connection.removeAllListeners()
		} catch (error) {
			this.logEvent('destruct', error, 'error')
		}
		try {
			this.connection.close()
		} catch (error) {
			this.logEvent('destruct', error, 'error')
		}
		this.connection = null;
		this.channel = {};
		return (true)
	}
	async onOpen() {
		this.logEvent('onOpen');
		this.startPing();
		try {
			this.serverKeys = await crypto.subtle.generateKey({
				name: 'ECDH',
				namedCurve: 'P-384'
			}, false, ['deriveKey', 'deriveBits']);
			this.serverShared = null;
			this.sendMessage(Buffer.from(await crypto.subtle.exportKey('raw', this.serverKeys.publicKey)).toString('hex'))
		} catch (error) {
			this.logEvent('onOpen', error, 'error')
		}
	}
	async onMessage(event) {
		if (!event || !this.isString(event.data)) {
			return
		}
		if (event.data === 'pong') {
			return
		}
		this.logEvent('onMessage', event.data);
		try {
			const data = JSON.parse(event.data);
			if (data.type === 'server-key') {
				const result = await this.handleServerKey(data.key);
				if (!result) {
					return
				}
			}
		} catch (e) {}
		if (!this.serverShared) {
			const parts = event.data.split('|');
			if (!parts[0] || !parts[1]) {
				return
			}
			try {
				if (await crypto.subtle.verify({
						name: 'RSASSA-PKCS1-v1_5'
					}, await crypto.subtle.importKey('spki', Buffer.from(this.config.rsaPublic, 'base64'), {
						name: 'RSASSA-PKCS1-v1_5',
						hash: {
							name: 'SHA-256'
						}
					}, false, ['verify']), Buffer.from(parts[1], 'base64'), Buffer.from(parts[0], 'hex')) === true) {
					this.serverShared = Buffer.from(await crypto.subtle.deriveBits({
						name: 'ECDH',
						namedCurve: 'P-384',
						public: await crypto.subtle.importKey('raw', Buffer.from(parts[0], 'hex'), {
							name: 'ECDH',
							namedCurve: 'P-384'
						}, true, [])
					}, this.serverKeys.privateKey, 384)).slice(8, 40);
					this.sendMessage(this.encryptServerMessage({
						a: 'j',
						p: this.credentials.channel
					}, this.serverShared));
					if (this.callbacks.onServerSecured) {
						try {
							this.callbacks.onServerSecured()
						} catch (error) {
							this.logEvent('onMessage-server-secured-callback', error, 'error')
						}
					}
				}
			} catch (error) {
				this.logEvent('onMessage', error, 'error')
			}
			return
		}
		const serverDecrypted = this.decryptServerMessage(event.data, this.serverShared);
		this.logEvent('onMessage-server-decrypted', serverDecrypted);
		if (!this.isObject(serverDecrypted) || !this.isString(serverDecrypted.a)) {
			return
		}
		if (serverDecrypted.a === 'l' && this.isArray(serverDecrypted.p)) {
			try {
				for (const clientId in this.channel) {
					if (serverDecrypted.p.indexOf(clientId) < 0) {
						delete(this.channel[clientId])
					}
				}
				let payloads = {};
				for (const clientId of serverDecrypted.p) {
					if (!this.channel[clientId]) {
						this.channel[clientId] = {
							username: null,
							keys: this.clientEc.genKeyPair(),
							shared: null,
						};
						payloads[clientId] = this.channel[clientId].keys.getPublic('hex')
					}
				}
				if (Object.keys(payloads).length > 0) {
					this.sendMessage(this.encryptServerMessage({
						a: 'w',
						p: payloads,
					}, this.serverShared))
				}
			} catch (error) {
				this.logEvent('onMessage-list', error, 'error')
			}
			if (this.callbacks.onClientList) {
				let clients = [];
				for (const clientId in this.channel) {
					if (this.channel[clientId].shared && this.channel[clientId].username) {
						clients.push({
							clientId: clientId,
							username: this.channel[clientId].username
						})
					}
				}
				try {
					this.callbacks.onClientList(clients)
				} catch (error) {
					this.logEvent('onMessage-client-list-callback', error, 'error')
				}
			}
			return
		}
		if (!this.isString(serverDecrypted.p) || !this.isString(serverDecrypted.c)) {
			return
		}
		if (serverDecrypted.a === 'c' && (!this.channel[serverDecrypted.c] || !this.channel[serverDecrypted.c].shared)) {
			try {
				if (!this.channel[serverDecrypted.c]) {
					this.channel[serverDecrypted.c] = {
						username: null,
						keys: this.clientEc.genKeyPair(),
						shared: null,
					};
					this.sendMessage(this.encryptServerMessage({
						a: 'c',
						p: this.channel[serverDecrypted.c].keys.getPublic('hex'),
						c: serverDecrypted.c
					}, this.serverShared))
				}
				this.channel[serverDecrypted.c].shared = Buffer.from(this.xorHex(this.channel[serverDecrypted.c].keys.derive(this.clientEc.keyFromPublic(serverDecrypted.p, 'hex').getPublic()).toString('hex').padEnd(64, '8').substr(0, 64), this.credentials.password), 'hex');
				this.sendMessage(this.encryptServerMessage({
					a: 'c',
					p: this.encryptClientMessage({
						a: 'u',
						p: this.credentials.username
					}, this.channel[serverDecrypted.c].shared),
					c: serverDecrypted.c
				}, this.serverShared))
			} catch (error) {
				this.logEvent('onMessage-client', error, 'error')
			}
			return
		}
		if (serverDecrypted.a === 'c' && this.channel[serverDecrypted.c] && this.channel[serverDecrypted.c].shared) {
			const clientDecrypted = this.decryptClientMessage(serverDecrypted.p, this.channel[serverDecrypted.c].shared);
			this.logEvent('onMessage-client-decrypted', clientDecrypted);
			if (!this.isObject(clientDecrypted) || !this.isString(clientDecrypted.a)) {
				return
			}
			if (clientDecrypted.a === 'u' && this.isString(clientDecrypted.p) && clientDecrypted.p.match(/\S+/) && !this.channel[serverDecrypted.c].username) {
				this.channel[serverDecrypted.c].username = clientDecrypted.p.replace(/^\s+/, '').replace(/\s+$/, '');
				if (this.callbacks.onClientSecured) {
					try {
						this.callbacks.onClientSecured({
							clientId: serverDecrypted.c,
							username: this.channel[serverDecrypted.c].username
						})
					} catch (error) {
						this.logEvent('onMessage-client-secured-callback', error, 'error')
					}
				}
				return
			}
			if (!this.channel[serverDecrypted.c].username) {
				return
			}
			if (clientDecrypted.a === 'm' && this.isString(clientDecrypted.t) && this.isString(clientDecrypted.d)) {
				if (this.callbacks.onClientMessage) {
					try {
						this.callbacks.onClientMessage({
							clientId: serverDecrypted.c,
							username: this.channel[serverDecrypted.c].username,
							type: clientDecrypted.t,
							data: clientDecrypted.d
						})
					} catch (error) {
						this.logEvent('onMessage-client-message-callback', error, 'error')
					}
				}
				return
			}
		}
	}
	async onError(event) {
		this.logEvent('onError', event, 'error');
		this.disconnect();
		if (this.credentials) {
			this.startReconnect()
		}
		if (this.callbacks.onServerClosed) {
			try {
				this.callbacks.onServerClosed()
			} catch (error) {
				this.logEvent('onError-server-closed-callback', error, 'error')
			}
		}
	}
	async onClose(event) {
		this.logEvent('onClose', event);
		this.disconnect();
		if (this.credentials) {
			this.startReconnect()
		}
		if (this.callbacks.onServerClosed) {
			try {
				this.callbacks.onServerClosed()
			} catch (error) {
				this.logEvent('onClose-server-closed-callback', error, 'error')
			}
		}
	}
	logEvent(source, message, level) {
		if (this.config.debug) {
			const date = new Date(),
				dateString = date.getFullYear() + '-' + ('0' + (date.getMonth() + 1)).slice(-2) + '-' + ('0' + date.getDate()).slice(-2) + ' ' + ('0' + date.getHours()).slice(-2) + ':' + ('0' + date.getMinutes()).slice(-2) + ':' + ('0' + date.getSeconds()).slice(-2);
			console.log('[' + dateString + ']', (level ? level.toUpperCase() : 'INFO'), source + (message ? ':' : ''), (message ? message : ''))
		}
	}
	isOpen() {
		return (this.connection && this.connection.readyState && this.connection.readyState === WebSocket.OPEN ? true : false)
	}
	isClosed() {
		return (!this.connection || !this.connection.readyState || this.connection.readyState === WebSocket.CLOSED ? true : false)
	}
	startReconnect() {
		this.stopReconnect();
		this.logEvent('startReconnect');
		this.reconnect = setTimeout(() => {
			this.reconnect = null;
			this.connect()
		}, this.config.reconnectDelay)
	}
	stopReconnect() {
		if (this.reconnect) {
			this.logEvent('stopReconnect');
			clearTimeout(this.reconnect);
			this.reconnect = null
		}
	}
	startPing() {
		this.stopPing();
		this.logEvent('startPing');
		this.ping = setInterval(() => {
			this.sendMessage('ping')
		}, this.config.pingInterval)
	}
	stopPing() {
		if (this.ping) {
			this.logEvent('stopPing');
			clearInterval(this.ping);
			this.ping = null
		}
	}
	disconnect() {
		this.stopReconnect();
		this.stopPing();
		if (!this.isClosed()) {
			try {
				this.logEvent('disconnect');
				this.connection.close()
			} catch (error) {
				this.logEvent('disconnect', error, 'error')
			}
		}
	}
	sendMessage(message) {
		try {
			if (this.isOpen()) {
				this.connection.send(message);
				return (true)
			}
		} catch (error) {
			this.logEvent('sendMessage', error, 'error')
		}
		return (false)
	}
	sendChannelMessage(type, data) {
		if (this.serverShared) {
			try {
				let payloads = {};
				for (const clientId in this.channel) {
					if (this.channel[clientId].shared && this.channel[clientId].username) {
						payloads[clientId] = this.encryptClientMessage({
							a: 'm',
							t: type,
							d: data
						}, this.channel[clientId].shared);
						if (payloads[clientId].length === 0) {
							return (false)
						}
					}
				}
				if (Object.keys(payloads).length > 0) {
					const payload = this.encryptServerMessage({
						a: 'w',
						p: payloads,
					}, this.serverShared);
					if (!this.isOpen() || payload.length === 0 || payload.length > (8 * 1024 * 1024)) {
						return (false)
					}
					this.connection.send(payload)
				}
				return (true)
			} catch (error) {
				this.logEvent('sendChannelMessage', error, 'error')
			}
		}
		return (false)
	}
	encryptServerMessage(message, key) {
		let encrypted = '';
		try {
			message = Buffer.from(JSON.stringify(message), 'utf8');
			if ((message.length % 16) !== 0) {
				message = Buffer.from([...message, ...Buffer.alloc(16 - (message.length % 16))])
			}
			const iv = Buffer.from(crypto.getRandomValues(new Uint8Array(16)));
			const cipher = new ModeOfOperation.cbc(key, iv);
			encrypted = iv.toString('base64') + '|' + Buffer.from(cipher.encrypt(message)).toString('base64')
		} catch (error) {
			this.logEvent('encryptServerMessage', error, 'error')
		}
		return (encrypted)
	}
	decryptServerMessage(message, key) {
		let decrypted = {};
		try {
			const parts = message.split('|');
			const decipher = new ModeOfOperation.cbc(key, Buffer.from(parts[0], 'base64'));
			decrypted = JSON.parse(Buffer.from(decipher.decrypt(Buffer.from(parts[1], 'base64'))).toString('utf8').replace(/\0+$/, ''))
		} catch (error) {
			this.logEvent('decryptServerMessage', error, 'error')
		}
		return (decrypted)
	}
	encryptClientMessage(message, key) {
		let encrypted = '';
		try {
			message = Buffer.from(JSON.stringify(message), 'utf8');
			if ((message.length % 16) !== 0) {
				message = Buffer.from([...message, ...Buffer.alloc(16 - (message.length % 16))])
			}
			const iv = Buffer.from(crypto.getRandomValues(new Uint8Array(12)));
			const counter = Buffer.from(crypto.getRandomValues(new Uint8Array(4)));
			const cipher = new chacha(key, iv, counter.reduce((a, b) => a * b));
			encrypted = iv.toString('base64') + '|' + counter.toString('base64') + '|' + Buffer.from(cipher.encrypt(message)).toString('base64')
		} catch (error) {
			this.logEvent('encryptClientMessage', error, 'error')
		}
		return (encrypted)
	}
	decryptClientMessage(message, key) {
		let decrypted = {};
		try {
			const parts = message.split('|');
			const decipher = new chacha(key, Buffer.from(parts[0], 'base64'), Buffer.from(parts[1], 'base64').reduce((a, b) => a * b));
			decrypted = JSON.parse(Buffer.from(decipher.decrypt(Buffer.from(parts[2], 'base64'))).toString('utf8').replace(/\0+$/, ''))
		} catch (error) {
			this.logEvent('decryptClientMessage', error, 'error')
		}
		return (decrypted)
	}
	xorHex(a, b) {
		let result = '',
			hexLength = Math.min(a.length, b.length);
		for (let i = 0; i < hexLength; ++i) {
			result += (parseInt(a.charAt(i), 16) ^ parseInt(b.charAt(i), 16)).toString(16)
		}
		return (result)
	}
	isString(value) {
		return (value && Object.prototype.toString.call(value) === '[object String]' ? true : false)
	}
	isArray(value) {
		return (value && Object.prototype.toString.call(value) === '[object Array]' ? true : false)
	}
	isObject(value) {
		return (value && Object.prototype.toString.call(value) === '[object Object]' ? true : false)
	}
	async handleServerKey(serverKey) {
		this.logEvent('handleServerKey', 'Received server key');
		localStorage.removeItem(this.SERVER_KEY_STORAGE);
		localStorage.setItem(this.SERVER_KEY_STORAGE, serverKey);
		this.config.rsaPublic = serverKey;
		return true
	}
};
if (typeof window !== 'undefined') {
	window.NodeCrypt = NodeCrypt
}