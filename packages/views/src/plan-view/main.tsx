// First, before any module that builds a zod schema.
import './no-eval.ts';
import { createRoot } from 'react-dom/client';
import { PlanView } from './PlanView.tsx';
import './styles.css';

const root = document.getElementById('root');
if (root) createRoot(root).render(<PlanView />);
