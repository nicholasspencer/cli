var usb = 'MOCK_USB' in process.env ? {} : require('usb');
var util = require('util');
var async = require('async');
var EventEmitter = require('events').EventEmitter;

var TESSEL_VID = 0x1d50;
var TESSEL_PID = 0x6097;

var REQ_INFO = 0x00;
var REQ_KILL = 0x10;
var REQ_STACK_TRACE = 0x11;
var REQ_WIFI = 0x20;
var REQ_CC = 0x21;

var VENDOR_REQ_OUT = usb.LIBUSB_REQUEST_TYPE_VENDOR | usb.LIBUSB_RECIPIENT_DEVICE | usb.LIBUSB_ENDPOINT_OUT;
var VENDOR_REQ_IN  = usb.LIBUSB_REQUEST_TYPE_VENDOR | usb.LIBUSB_RECIPIENT_DEVICE | usb.LIBUSB_ENDPOINT_IN;

function Tessel(dev) {
	this.usb = dev;
}

exports.Tessel = Tessel;

util.inherits(Tessel, EventEmitter);

Tessel.prototype.init = function init(next) {
	var self = this;
	this.usb.open();
	this.initCommands();

	this.logColors = true;
	this.logLevels = [];

	this.usb.getStringDescriptor(this.usb.deviceDescriptor.iSerialNumber, function (error, data) {
		if (error) return next(error);
		self.serialNumber = data;
		self._info(function(err, info) {
			if (err) return next(error);
			self.version = info;
			next(null, self);
		})
	})
}

Tessel.prototype.claim = function claim(next) {
	// Runs the claiming procedure exactly once, and calls next after it has completed
	if (this.claimed === 'claimed') {
		// Already claimed
		return setImmediate(next);
	}

	this.once('claimed', next);

	if (!this.claimed) {
		this.claimed = 'claiming';
		var self = this;
		self.intf = self.usb.interface(0);
		self.intf.claim();
		// We use an alternate setting so it is automatically released if the program is killed
		self.intf.setAltSetting(1, function(error) {
			if (error) return next(error);
			self.log_ep = self.intf.endpoints[0];
			self.msg_in_ep = self.intf.endpoints[1];
			self.msg_out_ep = self.intf.endpoints[2];
			self.claimed = 'claimed';

			self.usb.timeout = 10000;

			self._receiveLogs();
			self._receiveMessages();

			self.emit('claimed');
		});
	}
}

Tessel.prototype.close = function close() {
	this.usb.close();
}

Tessel.prototype.listen = function listen(colors, levels) {
	this.logColors = colors;
	this.logLevels = levels;
}

Tessel.prototype._receiveLogs = function _receiveLogs() {
	var self = this;
	self.log_ep.startStream(4, 4096);
	self.log_ep.on('data', function(data) {
		var pos = 0;
		while (pos < data.length) {
			if (data[pos] !== 1) { throw new Error("Expected STX at"+ pos +' ' + data[pos]) }
			var level = data[pos+1];
			
			for (var next=pos+2; next<data.length; next++) {
				if (data[next] === 1) {
					break;
				}
			}

			var str = data.toString('utf8', pos+2, next);

			if (level == 10 || level == 11 || level == 12) {
				self.stdout.push(str + '\n');
			}
			if (level == 13) {
				self.stderr.push(str + '\n');
			}

			if ((!self.logLevels && typeof self.logLevels != 'array') || self.logLevels.indexOf(level) != -1) {
				process.stdout.write(str + "\n");
			}

			self.emit('log', level, str);
			pos = next;
		}
	});

	self.once('end', function () {
		self.log_ep.stopStream();
	});
}

Tessel.prototype.postMessage = function postMessage(tag, buf, cb) {
	var header = new Buffer(8);
	header.writeUInt32LE(buf.length, 0);
	header.writeUInt32LE(tag, 4);
	var data = Buffer.concat([header, buf]);

	this.msg_out_ep.transferWithZLP(data, function(error) {
		cb && cb(error);
	});
}

Tessel.prototype.command = function command(cmd, buf, next) {
	next = next || function(error) { if(error) console.error(error); }
	this.postMessage(cmd.charCodeAt(0), buf, next);
}

Tessel.prototype._receiveMessages = function _receiveMessages() {
	var self = this;

	var transferSize = 4096;
	self.msg_in_ep.startStream(2, transferSize);

	var buffers = [];
	self.msg_in_ep.on('data', function(data) {
		buffers.push(data);
		if (data.length < transferSize) {
			var b = Buffer.concat(buffers);
			if (b.length > 0) {
				var len = b.readUInt16LE(0);
				var tag = b.readUInt16LE(4);
				b = b.slice(8);

				self.emit('rawMessage', tag, b);

				if (tag >> 24 === 0) {
					self.emit('command', String.fromCharCode(tag&0xff), b.toString('utf8'));
				}
			}

			buffers = [];
		}
	});

	self.once('end', function () {
		self.msg_in_ep.stopStream();
	});
};

Tessel.prototype.end = function end() {
	this.emit('end');
};

Tessel.prototype._info = function info(next) {
	this.usb.controlTransfer(VENDOR_REQ_IN, REQ_INFO, 0, 0, 512, function(error, data) {
		if (error) return next(error);
		next(null, JSON.parse(data.toString()));
	});
}

Tessel.prototype.stop = function stop(next) {
	this.usb.controlTransfer(VENDOR_REQ_OUT, REQ_KILL, 0, 0, new Buffer(0), next);
}

Tessel.prototype.debugstack = function stop(next) {
	this.usb.controlTransfer(VENDOR_REQ_OUT, REQ_STACK_TRACE, 0, 0, new Buffer(0), function(err) {
		if (err) {
			this.removeListener('command', oncommand);
			next(err);
		}
	});

	function oncommand(command, msg) {
		if (command == 'k') {
			this.removeListener('command', oncommand);
			next(null, msg.toString());
		}
	}

	this.on('command', oncommand)
}

Tessel.prototype.wifiIP = function (next) {
	this.usb.controlTransfer(VENDOR_REQ_IN, REQ_WIFI, 0, 0, 4, function(error, data) {
		var ip = data[0]+"."+data[1]+"."+data[2]+"."+data[3];
		if (error) return next(error);
		next(null, ip);
	});
}

Tessel.prototype.wifiVer = function (next) {
	this.usb.controlTransfer(VENDOR_REQ_IN, REQ_CC, 0, 0, 2, function(error, data) {
		var version = data[0]+"."+data[1];
		if (error) return next(error);
		next(null, version);
	});
}

exports.findTessel = function findTessel(desiredSerial, next) {
	exports.listDevices(function (err, devices) {
		if (err) return next(err);

		for (var i=0; i<devices.length; i++) {
			if (!desiredSerial || desiredSerial == devices[i].serialNumber) {
				devices[i].claim(function(err) {
					if (err) return next(err);
					return next(null, devices[i]);
				});
				return;
			}
		}

		return next(desiredSerial?"Device not found.":"No devices found.", null);
	});
}

exports.listDevices = function listDevices(next) {
	var devices = usb.getDeviceList().map(function(dev) {
		if ((dev.deviceDescriptor.idVendor == TESSEL_VID) && (dev.deviceDescriptor.idProduct == TESSEL_PID)) {
			return new Tessel(dev);
		}
	}).filter(function(x) {return x});

	async.each(devices, function(dev, cb) { dev.init(cb) }, function(err) { next(err, devices)} );
}