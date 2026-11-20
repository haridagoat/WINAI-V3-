# One image with both runtimes: Node runs the site, Python runs the stats scripts the server starts each morning.
FROM node:24-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Python packages live in their own environment so nothing touches the system Python.
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .
ENV NODE_ENV=production
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
