import * as ping from 'ping';
import * as dgram from 'dgram';
import * as net from 'net';
import axios from 'axios';
import * as fs from 'fs';
import * as ini from 'ini';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

const serverConfig = ini.parse(fs.readFileSync('config.ini', 'utf-8'));

const botToken = serverConfig.discord.bot_token;
const channelId = serverConfig.discord.channel_id;
let discordMessageId: string | null = null;

interface ServerConfig {
  name: string;
  ip: string;
  port: number;
  protocol: 'tcp' | 'udp';
}

const servers: ServerConfig[] = Object.keys(serverConfig)
  .filter(key => key.startsWith('server'))
  .map(key => ({
    name: serverConfig[key].name,
    ip: serverConfig[key].ip,
    port: parseInt(serverConfig[key].port, 10),
    protocol: serverConfig[key].protocol as 'tcp' | 'udp'
  }));

const dbPromise = open({
  filename: './server_status.db',
  driver: sqlite3.Database
});

async function setupDatabase() {
  const db = await dbPromise;
  await db.exec(`
    CREATE TABLE IF NOT EXISTS server_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      ip TEXT,
      port INTEGER,
      protocol TEXT,
      status TEXT,
      ping INTEGER,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function pingServer(ip: string): Promise<number | null> {
  try {
    const res = await ping.promise.probe(ip);
    return res.alive ? (typeof res.time === 'number' ? res.time : null) : null;
  } catch {
    return null;
  }
}

function checkTCPPort(ip: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(3000);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    }).on('timeout', () => {
      socket.destroy();
      resolve(false);
    }).on('error', () => {
      resolve(false);
    }).connect(port, ip);
  });
}

function checkUDPPort(ip: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const client = dgram.createSocket('udp4');
    client.on('error', () => {
      client.close();
      resolve(false);
    });

    client.send('', port, ip, (err) => {
      client.close();
      resolve(!err);
    });
  });
}

async function checkServerStatus(server: ServerConfig): Promise<{ name: string, status: string, ping: number | null }> {
  const pingTime = await pingServer(server.ip);
  const isPortOpen = server.protocol === 'tcp'
    ? await checkTCPPort(server.ip, server.port)
    : await checkUDPPort(server.ip, server.port);

  let status = '🔴 Down';
  if (pingTime !== null && isPortOpen) {
    if (pingTime < 100) {
      status = '🟢 Good';
    } else if (pingTime < 200) {
      status = '🟡 Degraded';
    } else {
      status = '🔴 Down';
    }
  }

  return { name: server.name, status, ping: pingTime !== null ? pingTime : null };
}

async function sendDiscordNotification(statuses: { name: string, status: string, ping: number | null }[]) {
  const nextUpdateInUnix = Math.floor((Date.now() + 30000) / 1000);
  
  const overallStatus = statuses.some(status => status.status.includes('🔴'))
    ? '🔴 Critical'
    : statuses.some(status => status.status.includes('🟡'))
    ? '🟡 Warning'
    : '🟢 Operational';

  const summaryEmbed = {
    title: 'Server Status Summary',
    description: `**Overall Status:** ${overallStatus}\n\nLast updated: <t:${Math.floor(Date.now() / 1000)}:R>\nNext update: <t:${nextUpdateInUnix}:R>`,
    color: 0x2F3136, // Dark grey color
  };

  const serverFields = statuses.map(status => ({
    name: status.name,
    value: `${status.status} | Ping: ${status.ping !== null ? `${status.ping} ms` : 'N/A'}`,
    inline: true
  }));

  const detailsEmbed = {
    title: 'Server Details',
    fields: serverFields,
    color: 0x2F3136, // Dark grey color
  };

  const messagePayload = { 
    embeds: [summaryEmbed, detailsEmbed]
  };

  try {
    if (discordMessageId) {
      await axios.patch(`https://discord.com/api/v10/channels/${channelId}/messages/${discordMessageId}`, messagePayload, {
        headers: {
          Authorization: `Bot ${botToken}`,
          'Content-Type': 'application/json'
        }
      });
    } else {
      const response = await axios.post(`https://discord.com/api/v10/channels/${channelId}/messages`, messagePayload, {
        headers: {
          Authorization: `Bot ${botToken}`,
          'Content-Type': 'application/json'
        }
      });
      discordMessageId = response.data.id;
    }
  } catch (error) {
    console.error('Error sending notification to Discord:', error);
  }
}


async function monitorServers() {
  const db = await dbPromise;
  const statuses = await Promise.all(servers.map(server => checkServerStatus(server)));

  await Promise.all(statuses.map(status =>
    db.run('INSERT INTO server_status (name, ip, port, protocol, status, ping) VALUES (?, ?, ?, ?, ?, ?)',
      [status.name, servers.find(s => s.name === status.name)?.ip, servers.find(s => s.name === status.name)?.port, servers.find(s => s.name === status.name)?.protocol, status.status, status.ping]
    )
  ));

  await sendDiscordNotification(statuses);
}

async function startMonitoring() {
  await setupDatabase();
  setInterval(async () => {
    await monitorServers();
  }, 30000);
  await monitorServers();
}

startMonitoring();