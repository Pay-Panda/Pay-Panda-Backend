const path = require('path');
const winston = require('winston');
require('winston-daily-rotate-file');

const logDir = path.join(__dirname, '..', '..', 'logs');
const colors = { error: 'bold red', warn: 'bold yellow', info: 'cyan', http: 'magenta', verbose: 'blue', debug: 'gray' };
winston.addColors(colors);

const timestamp = winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' });
const consoleFormat = winston.format.combine(
  timestamp,
  winston.format.colorize({ all: true }),
  winston.format.printf(({ timestamp: time, level, message, event, requestId, ...meta }) => {
    const tag = event ? ` [${event}]` : '';
    const req = requestId ? ` [req:${requestId.slice(0, 8)}]` : '';
    const details = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${time} ${level}${tag}${req} ${message}${details}`;
  }),
);

const fileFormat = winston.format.combine(timestamp, winston.format.errors({ stack: true }), winston.format.json());
const daily = filename => new winston.transports.DailyRotateFile({
  dirname: logDir, filename, datePattern: 'YYYY-MM-DD', zippedArchive: true,
  maxSize: '20m', maxFiles: '30d', format: fileFormat,
});

const logger = winston.createLogger({
  levels: winston.config.npm.levels,
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  defaultMeta: { service: 'pay-panda-api' },
  transports: [
    new winston.transports.Console({ format: consoleFormat }),
    daily('application-%DATE%.log'),
    new winston.transports.DailyRotateFile({ dirname: logDir, filename: 'errors-%DATE%.log', datePattern: 'YYYY-MM-DD', level: 'error', zippedArchive: true, maxSize: '20m', maxFiles: '60d', format: fileFormat }),
  ],
  exceptionHandlers: [daily('exceptions-%DATE%.log')],
  rejectionHandlers: [daily('rejections-%DATE%.log')],
});

function safeError(error) {
  return { errorName: error?.name, errorMessage: error?.message, ...(process.env.NODE_ENV !== 'production' && error?.stack ? { stack: error.stack } : {}) };
}

module.exports = { logger, safeError, logDir };
