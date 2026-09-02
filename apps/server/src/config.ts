const parsePort = (value: string | undefined): number => {
  const port = Number(value ?? 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  return port;
};

export const config = {
  port: parsePort(process.env.PORT),
  webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
} as const;
