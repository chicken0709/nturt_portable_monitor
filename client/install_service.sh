#!/bin/bash
# Script that installs the NTURT Client as a systemd service

echo "Installing NTURT Client service..."

# Copy the service file to systemd directory
sudo cp /home/nturt/Desktop/nturacing_remote_monitor/client/nturt-client.service /etc/systemd/system/

# Reload systemd
sudo systemctl daemon-reload

# Enable the service (start on boot)
sudo systemctl enable nturt-client.service

# Start the service
sudo systemctl start nturt-client.service

echo ""
echo "Installation complete!"
echo ""
echo "Common used commands:"
echo "  Check status: sudo systemctl status nturt-client"
echo "  Start service: sudo systemctl start nturt-client"
echo "  Stop service: sudo systemctl stop nturt-client"
echo "  Restart service: sudo systemctl restart nturt-client"
echo "  View logs: sudo journalctl -u nturt-client -f"
echo "  Disable boot startup: sudo systemctl disable nturt-client"
