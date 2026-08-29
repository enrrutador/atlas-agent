import { execSync } from 'child_process';

interface SystemInfo {
  cpu: {
    usage: string;
    name: string;
    cores: number;
  };
  memory: {
    total: string;
    used: string;
    free: string;
    percentage: string;
  };
  disk: {
    drive: string;
    total: string;
    free: string;
    used: string;
    percentage: string;
  }[];
  topProcesses: {
    name: string;
    pid: number;
    memory: string;
    cpu: string;
  }[];
  timestamp: string;
}

export const skill = {
  name: "system_monitor",
  description: "Monitorea el sistema de la PC: CPU, RAM, disco y procesos",
  
  async execute(): Promise<SystemInfo> {
    const timestamp = new Date().toISOString();
    
    // CPU Info
    let cpuInfo = { usage: "N/A", name: "N/A", cores: 0 };
    try {
      const cpuName = execSync('wmic cpu get Name /value', { encoding: 'utf8' }).match(/Name=(.+)/)?.[1]?.trim() || "N/A";
      const cpuCores = parseInt(execSync('wmic cpu get NumberOfCores /value', { encoding: 'utf8' }).match(/NumberOfCores=(\d+)/)?.[1] || "0");
      
      // Get CPU usage via PowerShell
      const cpuUsage = execSync('powershell -command "Get-Counter \'\\Processor(_Total)\\% Processor Time\' | Select-Object -ExpandProperty CounterSamples | Select-Object -ExpandProperty CookedValue"', { encoding: 'utf8' }).trim();
      
      cpuInfo = {
        usage: parseFloat(cpuUsage).toFixed(1) + "%",
        name: cpuName,
        cores: cpuCores
      };
    } catch (e) {
      console.log("Error getting CPU info:", e);
    }
    
    // Memory Info
    let memoryInfo = { total: "N/A", used: "N/A", free: "N/A", percentage: "N/A" };
    try {
      const totalMem = parseInt(execSync('wmic ComputerSystem get TotalPhysicalMemory /value', { encoding: 'utf8' }).match(/TotalPhysicalMemory=(\d+)/)?.[1] || "0");
      const availableMem = parseInt(execSync('wmic OS get FreePhysicalMemory /value', { encoding: 'utf8' }).match(/FreePhysicalMemory=(\d+)/)?.[1] || "0") * 1024;
      
      const totalGB = (totalMem / (1024**3)).toFixed(2);
      const freeGB = (availableMem / (1024**3)).toFixed(2);
      const usedGB = (parseFloat(totalGB) - parseFloat(freeGB)).toFixed(2);
      const percentage = ((parseFloat(usedGB) / parseFloat(totalGB)) * 100).toFixed(1);
      
      memoryInfo = {
        total: totalGB + " GB",
        used: usedGB + " GB",
        free: freeGB + " GB",
        percentage: percentage + "%"
      };
    } catch (e) {
      console.log("Error getting memory info:", e);
    }
    
    // Disk Info
    let diskInfo: SystemInfo['disk'] = [];
    try {
      const diskData = execSync('wmic logicaldisk where "drivetype=3" get DeviceID,Size,FreeSpace /value', { encoding: 'utf8' });
      const drives = diskData.split('\n\n').filter(d => d.includes('DeviceID'));
      
      for (const drive of drives) {
        const letter = drive.match(/DeviceID=(.+)/)?.[1]?.trim() || "C:";
        const size = parseInt(drive.match(/Size=(\d+)/)?.[1] || "0");
        const free = parseInt(drive.match(/FreeSpace=(\d+)/)?.[1] || "0");
        const used = size - free;
        const percent = size > 0 ? ((used / size) * 100).toFixed(1) : "0";
        
        diskInfo.push({
          drive: letter,
          total: (size / (1024**3)).toFixed(2) + " GB",
          free: (free / (1024**3)).toFixed(2) + " GB",
          used: (used / (1024**3)).toFixed(2) + " GB",
          percentage: percent + "%"
        });
      }
    } catch (e) {
      console.log("Error getting disk info:", e);
    }
    
    // Top Processes by Memory
    let topProcesses: SystemInfo['topProcesses'] = [];
    try {
      const processData = execSync('tasklist /FI "STATUS eq running" /FO CSV /NH', { encoding: 'utf8' });
      const lines = processData.split('\n').slice(0, 10);
      
      topProcesses = lines.map(line => {
        const parts = line.replace(/"/g, '').split(',');
        return {
          name: parts[0]! || "Unknown",
          pid: parseInt(parts[1]! || "0") || 0,
          memory: parts[4]! || "0",
          cpu: "N/A"
        };
      }).filter(p => p.name !== "Unknown");
    } catch (e) {
      console.log("Error getting process info:", e);
    }
    
    return {
      cpu: cpuInfo,
      memory: memoryInfo,
      disk: diskInfo,
      topProcesses: topProcesses,
      timestamp: timestamp
    };
  },
  
  // Utility function to format the output nicely
  formatOutput(info: SystemInfo): string {
    let output = "📊 ESTADO DEL SISTEMA\n";
    output += "═══════════════════════\n\n";
    
    output += "🖥️  CPU:\n";
    output += `   Modelo: ${info.cpu.name}\n`;
    output += `   Núcleos: ${info.cpu.cores}\n`;
    output += `   Uso: ${info.cpu.usage}\n\n`;
    
    output += "💾 MEMORIA RAM:\n";
    output += `   Total: ${info.memory.total}\n`;
    output += `   Usada: ${info.memory.used} (${info.memory.percentage})\n`;
    output += `   Libre: ${info.memory.free}\n\n`;
    
    output += "💽 DISCOS:\n";
    for (const disk of info.disk) {
      output += `   ${disk.drive} - ${disk.used} / ${disk.total} (${disk.percentage} usado)\n`;
    }
    output += "\n";
    
    output += "🔝 PROCESOS PRINCIPALES:\n";
    for (const proc of info.topProcesses.slice(0, 5)) {
      output += `   ${proc.name} (PID: ${proc.pid}) - ${proc.memory}\n`;
    }
    
    return output;
  }
};