#!/bin/bash
# pr-prism bot server setup for Oracle ARM (Ubuntu 22.04+)
set -e

echo "=== pr-prism bot server setup ==="

# install node 20 LTS
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

echo "node $(node --version)"

# install nginx
if ! command -v nginx &>/dev/null; then
  sudo apt-get install -y nginx certbot python3-certbot-nginx
fi

# clone repo
APP_DIR="/opt/prism-bot"
if [ ! -d "$APP_DIR" ]; then
  sudo mkdir -p "$APP_DIR"
  sudo chown "$USER:$USER" "$APP_DIR"
  git clone https://github.com/StressTestor/pr-prism.git "$APP_DIR"
fi

cd "$APP_DIR"
npm install
npm run build

# create data directory
mkdir -p "$APP_DIR/data/repos"

# install systemd service
sudo cp server/deploy/prism-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable prism-bot
sudo systemctl start prism-bot

# install nginx config
sudo cp server/deploy/nginx.conf /etc/nginx/sites-available/prism-bot
sudo ln -sf /etc/nginx/sites-available/prism-bot /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

echo ""
echo "=== setup complete ==="
echo "1. copy your .env to $APP_DIR/server/.env"
echo "2. copy your GitHub App private key to $APP_DIR/private-key.pem"
echo "3. run: sudo systemctl restart prism-bot"
echo "4. run: sudo certbot --nginx -d your-domain.com"
