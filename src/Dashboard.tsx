import React, { useState } from 'react';
import { OpportunityList } from './components/OpportunityList';
import { ProfitStats } from './components/ProfitStats';
import { TransactionHistory } from './components/TransactionHistory';
import { PerformanceMetrics } from './dashboard/PerformanceMetrics';
import { ActivePositions } from './dashboard/ActivePositions';
import { LiveOrderBook } from './dashboard/LiveOrderBook';
import { StrategySelector } from './dashboard/StrategySelector';

export const Dashboard: React.FC = () => {
  const [activeTab, setActiveTab] = useState('opportunities');

  const tabs = [
    { id: 'opportunities', label: 'Live Opportunities', icon: '🎯' },
    { id: 'history', label: 'Transaction History', icon: '📊' },
    { id: 'stats', label: 'Profit Stats', icon: '💰' },
    { id: 'advanced', label: 'Advanced', icon: '⚡' }
  ];

  return (
    <div className="space-y-6">
      {/* Tab Navigation */}
      <div className="bg-gray-800 rounded-lg p-1 flex space-x-1">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex-1 py-3 px-4 rounded-lg font-medium transition-colors ${
              activeTab === tab.id
                ? 'bg-purple-600 text-white'
                : 'text-gray-400 hover:text-white hover:bg-gray-700'
            }`}
          >
            <span className="mr-2">{tab.icon}</span>
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="min-h-[600px]">
        {activeTab === 'opportunities' && (
          <div className="space-y-6">
            <PerformanceMetrics />
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="lg:col-span-2">
                <OpportunityList />
              </div>
              <div>
                <StrategySelector />
              </div>
            </div>
          </div>
        )}

        {activeTab === 'history' && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2">
              <TransactionHistory />
            </div>
            <div>
              <ActivePositions />
            </div>
          </div>
        )}

        {activeTab === 'stats' && (
          <div className="space-y-6">
            <ProfitStats />
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <PerformanceMetrics />
              <LiveOrderBook />
            </div>
          </div>
        )}

        {activeTab === 'advanced' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <LiveOrderBook />
            <div className="space-y-6">
              <ActivePositions />
              <StrategySelector />
            </div>
          </div>
        )}
      </div>
    </div>
  );
};