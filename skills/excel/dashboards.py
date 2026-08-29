"""
Dashboard Templates - Plantillas predefinidas para dashboards
"""
import pandas as pd
from typing import Dict, Any, Optional
import xlwings as xw


class DashboardTemplates:
    """Colección de plantillas de dashboards para Excel"""
    
    @staticmethod
    def sales_dashboard(manager, data: Dict[str, Any], title: str = "Dashboard de Ventas"):
        """
        Crea un dashboard de ventas completo
        
        Args:
            manager: Instancia de ExcelManager
            data: Dict con 'ventas', 'productos', 'vendedores'
        """
        wb = manager.wb
        
        # Hoja principal
        sheet = wb.sheets[0]
        sheet.name = "Dashboard"
        
        # Título
        sheet.range('B2').value = title
        sheet.range('B2').font.size = 24
        sheet.range('B2').font.bold = True
        sheet.range('B2').color = '#4472C4'
        
        # KPIs
        sheet.range('B4').value = "Resumen de Ventas"
        sheet.range('B4').font.size = 14
        sheet.range('B4').font.bold = True
        
        if 'ventas' in data:
            df_ventas = pd.DataFrame(data['ventas'])
            sheet.range('B6').value = df_ventas
            
            # Formato tabla
            sheet.range('B6').expand('table').api.Borders.Weight = 2
            sheet.range('B6').expand('table').api.Borders.Color = 0x000000
        
        # Gráfico
        if 'ventas' in data and len(data['ventas']) > 0:
            chart = sheet.charts.add()
            chart.chart_type = xw.ChartType.xlColumnClustered
            chart.set_source_data(sheet.range('B6').expand('table'))
            chart.left = sheet.range('H4').left
            chart.top = sheet.range('H4').top
            chart.width = 400
            chart.height = 250
            chart.api[1].ChartTitle.Text = "Ventas por Período"
    
    @staticmethod
    def inventory_dashboard(manager, data: Dict[str, Any], title: str = "Dashboard de Inventario"):
        """Dashboard de control de inventario"""
        wb = manager.wb
        sheet = wb.sheets[0]
        sheet.name = "Inventario"
        
        # Título
        sheet.range('B2').value = title
        sheet.range('B2').font.size = 24
        sheet.range('B2').font.bold = True
        sheet.range('B2').color = '#70AD47'
        
        if 'stock' in data:
            df_stock = pd.DataFrame(data['stock'])
            sheet.range('B4').value = df_stock
            
            # Formato condicional simple
            for row in range(5, 5 + len(df_stock)):
                qty_cell = sheet.range(f'D{row}')
                if qty_cell.value and qty_cell.value < 10:
                    qty_cell.color = '#FFC7CE'  # Rojo claro para stock bajo
    
    @staticmethod
    def financial_report(manager, data: Dict[str, Any], title: str = "Reporte Financiero"):
        """Reporte financiero con P&L"""
        wb = manager.wb
        sheet = wb.sheets[0]
        sheet.name = "Financiero"
        
        sheet.range('B2').value = title
        sheet.range('B2').font.size = 24
        sheet.range('B2').font.bold = True
        
        if 'ingresos' in data and 'egresos' in data:
            # Tabla resumen
            resumen = [
                ['Concepto', 'Monto'],
                ['Ingresos Totales', data['ingresos']],
                ['Egresos Totales', data['egresos']],
                ['Utilidad Neta', data['ingresos'] - data['egresos']]
            ]
            sheet.range('B4').value = resumen
            
            # Formato
            sheet.range('B4:C4').font.bold = True
            sheet.range('B4:C4').color = '#D9E1F2'
            sheet.range('C7').font.bold = True
            
            # Gráfico pastel
            chart = sheet.charts.add()
            chart.chart_type = xw.ChartType.xlPie
            chart.set_source_data(sheet.range('B5:C6'))
            chart.left = sheet.range('E4').left
            chart.top = sheet.range('E4').top
            chart.width = 300
            chart.height = 200


# Diccionario de plantillas disponibles
TEMPLATES = {
    'sales': DashboardTemplates.sales_dashboard,
    'inventory': DashboardTemplates.inventory_dashboard,
    'financial': DashboardTemplates.financial_report,
}
