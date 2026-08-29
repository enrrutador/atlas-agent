
export default {
  name: "system_monitor_v2",
  description: "Monitorea CPU, RAM, disco y procesos del sistema Windows",
  
  async execute() {
    try {
      const os = require('os');
      const { execSync } = require('child_process');
      
      // Obtener info de CPU
      const cpus = os.cpus();
      const cpuModel = cpus[0].model;
      const cpuCores = cpus.length;
      
      // Uso de CPU (usandoPowerShell para datos reales)
      let cpuUsage = "N/A";
      try {
        const result = execSync('powershell -command "Get-Counter \\"\\Processor(_Total)\\% Processor Time\\" | Select-Object -ExpandProperty CounterSamples | Select-Object -ExpandProperty CookedValue"', { timeout: 5000 }).toString().trim();
        cpuUsage = parseFloat(result).toFixed(1) + "%";
      } catch (e) {
        cpuUsage = "No disponible";
      }
      
      // Info de MEMORIA
      const totalMem = (os.totalmem() / (1024 ** 3)).toFixed(2);
      const freeMem = (os.freemem() / (1024 ** 3)).toFixed(2);
      const usedMem = (parseFloat(totalMem) - parseFloat(freeMem)).toFixed(2);
      const memPercent = ((parseFloat(usedMem) / parseFloat(totalMem)) * 100).toFixed(1);
      
      // Info de DISCO (C:)
      let diskInfo = { total: "N/A", free: "N/A", used: "N/A", percent: "N/A" };
      try {
        const diskOut = execSync('wmic logicaldisk where "DeviceID=\'C:\'" get Size,FreeSpace /value', { encoding: 'utf8', timeout: 5000 });
        const totalBytes = BigInt(diskOut.match(/Size=(\d+)/)?.[1] || "0");
        const freeBytes = BigInt(diskOut.match(/FreeSpace=(\d+)/)?.[1] || "0");
        const usedBytes = totalBytes - freeBytes;
        
        diskInfo.total = (Number(totalBytes) / (1024**3)).toFixed(2) + " GB";
        diskInfo.free = (Number(freeBytes) / (1024**3)).toFixed(2) + " GB";
        diskInfo.used = (Number(usedBytes) / (1024**3)).toFixed(2) + " GB";
        diskInfo.percent = ((Number(usedBytes) / Number(totalBytes)) * 100).toFixed(1) + "%";
      } catch (e) {
        diskInfo = { total: "Error", free: "Error", used: "Error", percent: "Error" };
      }
      
      // Top procesos por uso de memoria
      let processes = [];
      try {
        const taskOut = execSync('tasklist /FO CSV /NH', { encoding: 'utf8', timeout: 5000 });
        const lines = taskOut.split('\n').slice(1, 6);
        
        processes = lines.map((line: string) => {
          const parts = line.replace(/"/g, '').split(',');
          return {
            name: parts[0] || "N/A",
            pid: parts[1] || "N/A",
            mem: parts[4] || "N/A"
          };
        }).filter((p: { name: string }) => p.name !== "N/A" && p.name !== "");
      } catch (e) {
        processes = [{ name: "Error al obtener procesos", pid: "-", mem: "-" }];
      }
      
      // Formato de salida
      const output = `📊 ESTADO DEL SISTEMA - ${new Date().toLocaleTimeString()}
═══════════════════════════════════════

🖥️ PROCESADOR:
   Modelo: ${cpuModel.trim()}
   Núcleos: ${cpuCores}
   Uso actual: ${cpuUsage}

💾 MEMORIA RAM:
   Total: ${totalMem} GB
   Usada: ${usedMem} GB (${memPercent}%)
   Libre: ${freeMem} GB

💽 DISCO C:
   Total: ${diskInfo.total}
   Usado: ${diskInfo.used} (${diskInfo.percent})
   Libre: ${diskInfo.free}

🔝 PROCESOS PRINCIPALES:
${processes.map((p: { name: string; pid: string; mem: string }) => `   • ${p.name.substring(0, 25).padEnd(25)} | PID: ${p.pid.padEnd(6)} | Mem: ${p.mem}`).join('\n')}`;

    return output;

  } catch (error: any) {
    return `❌ Error al monitorear el sistema: ${error.message}`;
    }
  }
};
