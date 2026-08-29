"""
SKILL: Excel Pro Manager
Autor: Atlas
Versión: 1.0
Descripción: Manejo profesional de Excel con xlwings y openpyxl
"""

from .excel_manager import ExcelManager
from .dashboards import DashboardTemplates
from .utils import format_number, create_color_palette

__all__ = ['ExcelManager', 'DashboardTemplates', 'format_number', 'create_color_palette']