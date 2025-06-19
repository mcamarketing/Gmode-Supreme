import React, { useEffect } from 'react';
import { useModernWallet } from '../hooks/useModernWallet';

interface HeaderProps {
  onConnectionChange: (connected: boolean) => void;
}

export const Header: React.FC<HeaderProps> = ({ onConnectionChange }) => {
  const { address, isConnected, connect, disconnect, balance } = useModernWallet();

  useEffect(() => {
    onConnectionChange(isConnected);
  }, [isConnected, onConnectionChange]);

  const formatAddress = (addr: string) => {
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  };

  const formatBalance = (bal: string) => {
    const num = parseFloat(bal);
    return num.toFixed(4);
  };

  return (
    <header className="bg-gray-800 border-b border-gray-700">
      <div className="container mx-auto px-4 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-4">
            <h1 className="text-2xl font-bold bg-gradient-to-r from-purple-400 to-pink-400 bg-clip-text text-transparent">
              Godmode Supreme
            </h1>
            <span className="text-sm text-gray-400">MEV Bot Terminal</span>
          </div>

          <div className="flex items-center space-x-4">
            {isConnected && balance && (
              <div className="text-sm text-gray-400">
                <span className="text-gray-500">Balance:</span>{' '}
                <span className="text-white font-medium">{formatBalance(balance)} MATIC</span>
              </div>
            )}

            {isConnected && address ? (
              <div className="flex items-center space-x-3">
                <div className="flex items-center space-x-2 bg-gray-700 px-4 py-2 rounded-lg">
                  <div className="w-2 h-2 bg-green-500 rounded-full"></div>
                  <span className="text-sm font-medium">{formatAddress(address)}</span>
                </div>
                <button
                  onClick={disconnect}
                  className="bg-red-600 hover:bg-red-700 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                >
                  Disconnect
                </button>
              </div>
            ) : (
              <button
                onClick={connect}
                className="bg-purple-600 hover:bg-purple-700 px-6 py-2 rounded-lg font-medium transition-colors"
              >
                Connect Wallet
              </button>
            )}
          </div>
        </div>
      </div>
    </header>
  );
};