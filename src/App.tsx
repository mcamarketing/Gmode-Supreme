import React, { useState, useEffect } from 'react';
import { WalletProvider } from './providers/WalletProvider';
import { Dashboard } from './Dashboard';
import { Header } from './components/Header';
import { Footer } from './components/Footer';
import { BackendStatus } from './components/BackendStatus';
import { useBackendData } from './hooks/useBackendData';
import './App.css';

function App() {
  const [isConnected, setIsConnected] = useState(false);
  const { status, isLoading, error } = useBackendData();

  return (
    <WalletProvider>
      <div className="min-h-screen bg-gray-900 text-white flex flex-col">
        <Header onConnectionChange={setIsConnected} />
        
        <main className="flex-grow container mx-auto px-4 py-8">
          <div className="mb-6">
            <BackendStatus status={status} isLoading={isLoading} error={error} />
          </div>
          
          {isConnected ? (
            <Dashboard />
          ) : (
            <div className="flex items-center justify-center h-96">
              <div className="text-center">
                <h1 className="text-4xl font-bold mb-4">Welcome to Godmode Supreme</h1>
                <p className="text-xl text-gray-400 mb-8">
                  Trade with Zero Capital. Execute MEV Strategies. Keep 80% of Profits.
                </p>
                <button className="bg-purple-600 hover:bg-purple-700 px-8 py-3 rounded-lg font-semibold text-lg transition-colors">
                  Connect Wallet to Start
                </button>
              </div>
            </div>
          )}
        </main>
        
        <Footer />
      </div>
    </WalletProvider>
  );
}

export default App;