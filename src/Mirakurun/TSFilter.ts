/*
   Copyright 2016 Yuki KAN

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
*/
/// <reference path="../../typings/node/node.d.ts" />
'use strict';

import stream = require('stream');
import _ = require('./_');
import log = require('./log');
import epg = require('./epg');
import ServiceItem = require('./ServiceItem');
const aribts = require('aribts');
const CRC32_TABLE = require('../../node_modules/aribts/lib/crc32_table');

interface StreamOptions extends stream.DuplexOptions {
    serviceId?: number;
    eventId?: number;
    noProvide?: boolean;
    parseSDT?: boolean;
    parseEIT?: boolean;
}

const PACKET_SIZE = 188;

const PROVIDE_PIDS = [
    0x0000,// PAT
    0x0001,// CAT
    0x0010,// NIT
    0x0011,// SDT
    0x0012,// EIT
    0x0013,// RST
    0x0014,// TDT
    0x0023,// SDTT
    0x0024,// BIT
    0x0028// SDTT
];

class TSFilter extends stream.Duplex {

    // options
    private _provideServiceId: number;
    private _provideEventId: number;
    private _parseSDT: boolean = false;
    private _parseEIT: boolean = false;

    // aribts
    private _parser: stream.Transform = new aribts.TsStream();
    //private _tsUtil = new aribts.TsUtil();

    // buffer
    private _packet: Buffer = new Buffer(PACKET_SIZE);
    private _offset: number = -1;
    private _buffer: Buffer[] = [];
    private _parses: Buffer[] = [];
    private _patsec: Buffer = new Buffer(20);

    // state
    private _closed: boolean = false;
    private _ready: boolean = true;
    private _providePids: number[] = null;// `null` to provides all
    private _parsePids: number[] = [];
    private _tsid: number = -1;
    private _patCRC: number = -1;
    private _serviceIds: number[] = [];
    private _services: any[] = [];
    private _parseServiceIds: number[] = [];
    private _pmtPid: number = -1;
    private _pmtTimer: NodeJS.Timer;

    // stream options
    private highWaterMark: number = 1024 * 1024 * 16;

    // ReadableState in node/lib/_stream_readable.js
    private _readableState: any;

    constructor(options: StreamOptions) {
        super({
            allowHalfOpen: false
        });

        this._provideServiceId = options.serviceId || null;
        this._provideEventId = options.eventId || null;

        if (this._provideServiceId !== null) {
            this._providePids = PROVIDE_PIDS.concat();
            this._ready = false;
        }
        if (this._provideEventId !== null) {
            this._ready = false;
        }
        if (options.noProvide === true) {
            this._provideServiceId = null;
            this._provideEventId = null;
            this._providePids = [];
            this._ready = false;
        }
        if (options.parseSDT === true) {
            this._parseSDT = true;
        }
        if (options.parseEIT === true) {
            this._parseEIT = true;
        }

        this._parser.resume();
        this._parser.on('pat', this._onPAT.bind(this));
        this._parser.on('pmt', this._onPMT.bind(this));
        this._parser.on('sdt', this._onSDT.bind(this));
        this._parser.on('eit', this._onEIT.bind(this));

        this.once('finish', this._close.bind(this));
        this.once('close', this._close.bind(this));

        log.debug('TSFilter has created (serviceId=%s, eventId=%s)', this._provideServiceId, this._provideEventId);

        if (this._ready === false) {
            log.debug('TSFilter is waiting for serviceId=%s, eventId=%s', this._provideServiceId, this._provideEventId);
        }
    }

    _read(size: number) {

        if (this._closed === true) {
            this.push(null);
        }
    }

    _write(chunk: Buffer, encoding, callback: Function) {

        if (this._closed === true) {
            callback(new Error('TSFilter has closed already'));
            return;
        }

        // stringent safety measure
        if (this._readableState.length > this.highWaterMark) {
            log.error('TSFilter is closing because overflowing the buffer...');
            return this._close();
        }

        let offset = 0;
        const length = chunk.length;

        if (this._offset > 0) {
            if (chunk.length >= PACKET_SIZE - this._offset) {
                chunk.copy(this._packet, this._offset, 0, PACKET_SIZE - this._offset);
                this._processPacket(this._packet);
                offset = PACKET_SIZE - this._offset;
                this._offset = 0;
            } else {
                chunk.copy(this._packet, this._offset);
                this._offset += chunk.length;

                // chunk drained
                callback();
                return;
            }
        } else {
            for (; offset < length; offset++) {
                // sync byte (0x47) searching
                if (chunk[offset] === 71) {
                    this._offset = 0;
                    break;
                }
            }
        }

        for (; offset < length; offset += PACKET_SIZE) {
            // sync byte (0x47) verifying
            if (chunk[offset] !== 71) {
                offset -= PACKET_SIZE - 1;
                this._offset = -1;
                continue;
            }

            if (length - offset >= PACKET_SIZE) {
                this._processPacket(chunk.slice(offset, offset + PACKET_SIZE));
                this._offset = 0;
            } else {
                chunk.copy(this._packet, 0, offset);
                this._offset = length - offset;
            }
        }

        if (this._buffer.length !== 0) {
            this.push(Buffer.concat(this._buffer));
            this._buffer = [];
        }

        if (this._parses.length !== 0) {
            this._parser.write(Buffer.concat(this._parses));
            this._parses = [];
        }

        callback();
    }

    private _processPacket(packet: Buffer): void {

        const pid = packet.readUInt16BE(1) & 0x1FFF;

        // NULL (0x1FFF)
        if (pid === 8191) {
            return;
        }

        packet = new Buffer(packet);

        // parse
        if (pid === 0 && this._patCRC !== packet.readInt32BE(packet[7] + 4)) {
            this._patCRC = packet.readInt32BE(packet[7] + 4);
            this._parses.push(packet);
        } else if ((pid === 0x12 && (this._parseEIT === true || this._provideEventId !== null)) || this._parsePids.indexOf(pid) !== -1) {
            this._parses.push(packet);
        }

        if (this._ready === false) {
            return;
        }
        if (this._providePids !== null && this._providePids.indexOf(pid) === -1) {
            return;
        }

        // PAT (0) rewriting
        if (pid === 0 && this._pmtPid !== -1) {
            this._patsec.copy(packet, 5, 0);
        }

        this._buffer.push(packet);
    }

    private _onPAT(pid, data): void {

        this._tsid = data.transport_stream_id;
        this._serviceIds = [];
        this._parseServiceIds = [];

        let i = 0, l = data.programs.length, id: number, item: ServiceItem;
        for (; i < l; i++) {
            id = data.programs[i].program_number;

            if (id === 0) {
                log.debug('TSFilter detected NIT PID=%d', data.programs[i].network_PID);
                continue;
            }

            this._serviceIds.push(id);
            item = _.service.get(id);

            log.debug(
                'TSFilter detected PMT PID=%d as serviceId=%d (%s)',
                data.programs[i].program_map_PID, id, item ? item.name : 'unregistered'
            );

            // detect PMT PID by specific service id
            if (this._provideServiceId === id) {
                if (this._pmtPid !== data.programs[i].program_map_PID) {
                    this._pmtPid = data.programs[i].program_map_PID;

                    if (this._providePids.indexOf(this._pmtPid) === -1) {
                        this._providePids.push(this._pmtPid);
                    }
                    if (this._parsePids.indexOf(this._pmtPid) === -1) {
                        this._parsePids.push(this._pmtPid);
                    }

                    // edit PAT section
                    data._raw.copy(this._patsec, 0, 0, 8);

                    // section_length
                    this._patsec[2] = 17;// 0x11

                    // network_number = 0
                    this._patsec[8] = 0;
                    this._patsec[9] = 0;
                    // network_PID
                    this._patsec[10] = 224;
                    this._patsec[11] = 16;

                    // program_number
                    this._patsec[12] = id >> 8;
                    this._patsec[13] = id & 255;
                    // program_map_PID
                    this._patsec[14] = (this._pmtPid >> 8) + 224;
                    this._patsec[15] = this._pmtPid & 255

                    // calculate CRC32
                    this._patsec.writeInt32BE(calcCRC32(this._patsec.slice(0, 16)), 16);
                }
            }

            if (this._parseEIT === true && item) {
                if (item.channel.type === 'GR') {
                    item.channel.getServices().forEach(item => {
                        if (this._parseServiceIds.indexOf(item.id) === -1) {
                            this._parseServiceIds.push(item.id);

                            log.debug('TSFilter parsing serviceId=%d (%s)', item.id, item.name);
                        }
                    });
                } else {
                    _.channel.findByType(item.channel.type).forEach(ch => {
                        ch.getServices().forEach(item => {
                            if (this._parseServiceIds.indexOf(item.id) === -1) {
                                this._parseServiceIds.push(item.id);

                                log.debug('TSFilter parsing serviceId=%d (%s)', item.id, item.name);
                            }
                        });
                    });
                }
            }
        }

        if (this._parseSDT === true) {
            if (this._parsePids.indexOf(17) === -1) {
                this._parsePids.push(17);
            }
        }
    }

    private _onPMT(pid, data): void {

        if (this._ready === false && this._provideServiceId !== null && this._provideEventId === null) {
            this._ready = true;

            log.debug('TSFilter is now ready for serviceId=%d', this._provideServiceId);
        }

        if (this._providePids.indexOf(data.program_info[0].CA_PID) === -1) {
            this._providePids.push(data.program_info[0].CA_PID);
        }

        if (this._providePids.indexOf(data.PCR_PID) === -1) {
            this._providePids.push(data.PCR_PID);
        }

        let i = 0, l = data.streams.length;
        for (; i < l; i++) {
            if (this._providePids.indexOf(data.streams[i].elementary_PID) === -1) {
                this._providePids.push(data.streams[i].elementary_PID);
            }
        }

        // sleep
        i = this._parsePids.indexOf(pid);
        if (i !== -1) {
            this._parsePids.splice(i, 1);

            this._pmtTimer = setTimeout(() => {
                this._parsePids.push(pid);
            }, 1000);
        }
    }

    private _onSDT(pid, data): void {

        if (this._tsid !== data.transport_stream_id) {
            return;
        }

        let i = 0, j, l = data.services.length, m, name;
        for (; i < l; i++) {
            if (this._serviceIds.indexOf(data.services[i].service_id) === -1) {
                continue;
            }

            name = '';

            for (j = 0, m = data.services[i].descriptors.length; j < m; j++) {
                if (data.services[i].descriptors[j].descriptor_tag === 0x48) {
                    name = new aribts.TsChar(data.services[i].descriptors[j].service_name_char).decode();
                    break;
                }
            }

            if (this._services.some(service => service.id === data.services[i].service_id) === false) {
                this._services.push({
                    id: data.services[i].service_id,
                    name: name
                });
            }
        }

        //if (this._serviceIds.every(id => this._services.some(service => service.id === id)) === true) { }
        this.emit('services', this._services);

        i = this._parsePids.indexOf(pid);
        if (i !== -1) {
            this._parsePids.splice(i, 1);
        }
    }

    private _onEIT(pid, data): void {

        if (data.events.length === 0 || this._parseServiceIds.indexOf(data.service_id) === -1) {
            return;
        }

        // detect current event
        if (
            this._provideEventId !== null && data.table_id === 0x4E && data.section_number === 0 &&
            (this._provideServiceId === null || this._provideServiceId === data.service_id)
        ) {
            if (data.events[0].event_id === this._provideEventId) {
                if (this._ready === false) {
                    this._ready = true;

                    log.debug('TSFilter is now ready for eventId=%d', this._provideEventId);
                }
            } else {
                if (this._ready === true) {
                    this._ready = false;

                    log.debug('TSFilter is closing because eventId=%d has ended...', this._provideEventId);

                    return this._close();
                }
            }
        }

        // write EPG stream
        if (this._parseEIT === true && data.table_id !== 0x4E && data.table_id !== 0x4F) {
            epg.write(data);
        }
    }

    private _close(): void {

        if (this._closed === true) {
            return;
        }
        this._closed = true;

        // clear timer
        clearTimeout(this._pmtTimer);

        // clear buffer
        process.nextTick(() => {
            this._readableState.buffer = [];
            this._readableState.length = 0;
            this._patsec.fill(0);
            this._patsec = null;
            this._packet.fill(0);
            this._packet = null;
            this._buffer.forEach(packet => {
                packet.fill(0);
                packet = null;
            });
            this._buffer = null;
            this._parses.forEach(packet => {
                packet.fill(0);
                packet = null;
            });
            this._parses = null;
        });

        // clear instance
        this._parser.removeAllListeners();
        this._parser.end();
        this._parser = null;
        //this._tsUtil = null;

        this.emit('close');

        log.debug('TSFilter has closed (serviceId=%s, eventId=%s)', this._provideServiceId, this._provideEventId);
    }
}

function calcCRC32(buf: Buffer): number {
    let i = 0, l = buf.length, crc = -1;
    for (; i < l; i++) {
        crc = (crc << 8) ^ CRC32_TABLE[((crc >>> 24) ^ buf[i])];
    }
    return crc;
}

export = TSFilter;